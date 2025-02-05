import { createRequire } from "module";
import Random from "@reactioncommerce/random";
import ReactionError from "@reactioncommerce/reaction-error";
import fetch from "node-fetch";
import sharp from "sharp";
import config from "./config.js";
import createSaveImageJob from "./util/createSaveImageJob.js";

const require = createRequire(import.meta.url);

const {
  FileDownloadManager,
  FileRecord,
  MongoFileCollection,
  TempFileStore,
  RemoteUrlWorker,
  TempFileStoreWorker
} = require("@reactioncommerce/file-collections");
// nconst GridFSStore = require("@reactioncommerce/file-collections-sa-gridfs").default;
let S3Dummy;
try {
  S3Dummy = require("@demandcluster/demandcluster-nodecdn").default;
} catch {
  S3Dummy = require("@outgrowio/reaction-file-collections-sa-s3").default;
}
const S3Store = S3Dummy;

/* eslint-disable no-unused-vars */
/**
 * @returns {undefined}
 */
export default function setUpFileCollections({
  absoluteUrlPrefix,
  context,
  db,
  Logger,
  MediaRecords,
  mongodb
}) {
  FileRecord.downloadEndpointPrefix = "/assets/files";
  FileRecord.absoluteUrlPrefix = absoluteUrlPrefix;

  // 1024*1024*2 is the GridFSStore default chunk size, and 256k is default GridFS chunk size, but performs terribly
  // const gridFSStoresChunkSize = 1 * 1024 * 1024;

  /**
   * Image files are resized to 4 different sizes:
   * 1. `large` - 1000px by 1000px - preserves aspect ratio
   * 2. `medium` - 600px by 600px - preserves aspect ratio
   * 3. `small` - 235px by 235px - crops to square - creates png version
   * 4. `thumbnail` - 100px by 100px - crops to square - creates png version
   * @name imgTransforms
   * @memberof Files
   * @constant {Array}
   * @property {string} name - transform name that will be used as GridFS name
   * @property {object|undefined} transform - object with image transform settings
   * @property {number} size - transform size, only one number needed for both width & height
   * @property {string} mod - transform modifier function call,
   *   for example the `large` & `medium` image transforms want to preserve
   *   the image's aspect ratio and resize based on the larger width or height
   *   so we use the `max` Sharp modifier function.
   *   Check out the {@link http://sharp.pixelplumbing.com/en/stable/|Sharp Docs} for more helper functions.
   *   {@link http://sharp.pixelplumbing.com/en/stable/api-resize/#max|Sharp max()}
   *   {@link http://sharp.pixelplumbing.com/en/stable/api-resize/#crop|Sharp crop()}
   * @property {string} format - output image format
   * @summary Defines all image transforms
   * @ignore
   */
  const imgTransforms = [
    { name: "image", transform: { size: 1600, fit: "inside", format: "jpg", type: "image/jpeg" } },
    { name: "large", transform: { size: 1000, fit: "inside", format: "jpg", type: "image/jpeg" } },
    { name: "medium", transform: { size: 600, fit: "inside", format: "jpg", type: "image/jpeg" } },
    { name: "small", transform: { size: 235, fit: "cover", format: "png", type: "image/png" } },
    { name: "thumbnail", transform: { size: 100, fit: "cover", format: "png", type: "image/png" } }
  ];

  /**
   * @name buildGFS
   * @method
   * @memberof Files
   * @param {Object} options Options
   * @summary buildGFS returns a fresh GridFSStore instance from provided image transform settings.
   * @returns {GridFSStore} New GridFS store instance
   */
  const buildGFS = ({ name, transform }) => (
    new S3Store({
      name, // Should be provided within buildGFS
      isPublic: true,
      objectACL: "public-read",
      async transformWrite(fileRecord) {
        if (!transform) return null;

        const { size, fit, format, type } = transform;

        // Need to update the content type and extension of the file info, too.
        // The new size gets set correctly automatically by FileCollections package.
        fileRecord.type(type, { store: name });
        fileRecord.extension(format, { store: name });

        // resizing image, adding fit, setting output format
        return sharp()
          .resize({ width: size, height: size, fit: sharp.fit[fit], withoutEnlargement: true })
          .toFormat(format)
          .on("error", (err) => {
            throw new ReactionError("error-sharp-resize-internal", err);
          });
      }
    })
  );

  /**
   * @name stores
   * @memberof Files
   * @constant {Array}
   * @summary Defines an array of GridFSStore by mapping the imgTransform settings over the buildGFS function
   */
  const stores = imgTransforms.map(buildGFS);

  /**
   * @name tempStore
   * @type TempFileStore
   * @memberof Files
   * @summary Defines the temporary store where chunked uploads from browsers go
   * initially, until the chunks are eventually combined into one complete file
   * which the worker will then store to the permanent stores.
   * @see {@link https://github.com/reactioncommerce/reaction-file-collections}
   */
  const tempStore = new TempFileStore({
    shouldAllowRequest(req) {
      const { type } = req.uploadMetadata;
      if (typeof type !== "string" || !type.startsWith("image/")) {
        Logger.info(`shouldAllowRequest received request to upload file of type "${type}" and denied it`);
        return false;
      }
      return true;
    }
  });

  /**
   * @name Media
   * @type MongoFileCollection
   * @memberof Files
   * @summary Defines the Media FileCollection
   * To learn how to further manipulate images with Sharp, refer to
   * {@link http://sharp.pixelplumbing.com/en/stable/|Sharp Docs}
   * @see https://github.com/reactioncommerce/reaction-file-collections
   */
  const Media = new MongoFileCollection("Media", {
    allowGet: () => true, // add more security here if the files should not be public
    collection: MediaRecords,
    makeNewStringID: () => Random.id(),
    stores,
    tempStore
  });

  /**
   * @name downloadManager
   * @type FileDownloadManager
   * @memberof Files
   * @summary Set up a URL for downloading the files
   * @see https://github.com/reactioncommerce/reaction-file-collections
   */
  const downloadManager = new FileDownloadManager({
    collections: [Media],
    headers: {
      get: {
        "Cache-Control": "public, max-age=31536000"
      }
    }
  });

  const onNewRemoteFileRecord = (doc, collection) => {
    const { name } = collection;
    createSaveImageJob(context, doc, name, true);
  };

  const onNewTempFileRecord = (doc, collection) => {
    const { name } = collection;
    createSaveImageJob(context, doc, name, false);
  };

  let fileWorker;
  let remoteUrlWorker;

  // These workers use `.watch` API, which requires a replica set and proper read/write concern support.
  // Currently our in-memory Mongo server used for Jest integrations tests does not meet these needs,
  // so we skip this code if we're testing.
  if (config.NODE_ENV !== "test") {
    /**
     * @name remoteUrlWorker
     * @type RemoteUrlWorker
     * @memberof Files
     * @summary Start a worker to watch for inserted remote URLs and stream them to all stores
     * @see https://github.com/reactioncommerce/reaction-file-collections
     */
    remoteUrlWorker = new RemoteUrlWorker({ fetch, fileCollections: [Media], onNewFileRecord: onNewRemoteFileRecord });
    remoteUrlWorker.start();

    /**
     * @name fileWorker
     * @type TempFileStoreWorker
     * @memberof Files
     * @summary Start a worker to watch for finished uploads, store them permanently,
     * and then remove the temporary file
     * @see https://github.com/reactioncommerce/reaction-file-collections
     */
    fileWorker = new TempFileStoreWorker({ fileCollections: [Media], onNewFileRecord: onNewTempFileRecord });
    fileWorker.start();
  }

  return {
    downloadManager,
    fileWorker,
    Media,
    remoteUrlWorker,
    stores,
    tempStore
  };
}
