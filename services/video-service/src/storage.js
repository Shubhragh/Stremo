const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const config = require("./config");

const s3 = new S3Client({
  region: "us-east-1",
  endpoint: `${config.minioUseSSL ? "https" : "http"}://${config.minioEndpoint}:${config.minioPort}`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.minioAccessKey,
    secretAccessKey: config.minioSecretKey,
  },
});

async function uploadFile(bucket, objectKey, filepath, contentType = "application/octet-stream") {
  const fileStream = fs.createReadStream(filepath);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: fileStream,
      ContentType: contentType,
    })
  );
}

async function deleteFile(bucket, objectKey) {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: objectKey,
    })
  );
}

async function deleteObjectsWithPrefix(bucket, prefix) {
  const response = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
    })
  );

  if (!response.Contents || response.Contents.length === 0) {
    return;
  }

  const objectsToDelete = response.Contents.map((obj) => ({
    Key: obj.Key,
  }));

  if (objectsToDelete.length > 0) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objectsToDelete },
      })
    );
  }
}

module.exports = {
  uploadFile,
  deleteFile,
  deleteObjectsWithPrefix,
};
