import { chmodSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { fileTypeFromFile } from 'file-type';
import { dataDirectory } from './database.js';

const maximumFileSize = 5 * 1024 * 1024;
const uploadDirectory = path.join(dataDirectory, 'uploads');
const temporaryDirectory = path.join(uploadDirectory, '.tmp');

mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
mkdirSync(uploadDirectory, { recursive: true, mode: 0o700 });
chmodSync(uploadDirectory, 0o700);
chmodSync(temporaryDirectory, 0o700);

export const attachmentUpload = multer({
  defParamCharset: 'utf8',
  storage: multer.diskStorage({
    destination: temporaryDirectory,
    filename: (_req, _file, callback) => callback(null, randomUUID())
  }),
  limits: {
    fileSize: maximumFileSize,
    files: 5,
    fields: 5,
    fieldSize: 20 * 1024,
    parts: 10
  }
});

const allowedTypes = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['application/pdf', 'pdf']
]);

function removeFile(filePath) {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function cleanupTemporaryFiles(files = []) {
  for (const file of files) removeFile(file.path);
}

export async function persistAttachments(files, existingCount = 0) {
  if (existingCount + files.length > 5) {
    cleanupTemporaryFiles(files);
    const error = new Error('添付ファイルは1投稿につき最大5件です。');
    error.status = 400;
    throw error;
  }

  const validatedFiles = [];
  try {
    for (const file of files) {
      const detectedType = await fileTypeFromFile(file.path);
      const extension = allowedTypes.get(detectedType?.mime);
      if (!extension) {
        const error = new Error('JPEG、PNG、WebP、GIF画像またはPDFのみ添付できます。');
        error.status = 400;
        throw error;
      }

      const originalName = path.basename(file.originalname.replace(/\\/g, '/'))
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 200);
      validatedFiles.push({
        file,
        storedName: `${randomUUID()}.${extension}`,
        originalName: originalName || `attachment.${extension}`,
        mimeType: detectedType.mime,
        size: file.size
      });
    }
  } catch (error) {
    cleanupTemporaryFiles(files);
    throw error;
  }

  const movedFiles = [];
  try {
    for (const entry of validatedFiles) {
      const destination = path.join(uploadDirectory, entry.storedName);
      renameSync(entry.file.path, destination);
      movedFiles.push(destination);
    }
  } catch (error) {
    for (const movedFile of movedFiles) removeFile(movedFile);
    cleanupTemporaryFiles(files);
    throw error;
  }
  return validatedFiles.map(({ storedName, originalName, mimeType, size }) => ({
    storedName,
    originalName,
    mimeType,
    size
  }));
}

export function deleteStoredAttachment(storedName) {
  if (typeof storedName !== 'string' || path.basename(storedName) !== storedName) {
    throw new Error('添付ファイルの保存名が正しくありません。');
  }
  removeFile(path.join(uploadDirectory, storedName));
}

export function attachmentPath(storedName) {
  if (typeof storedName !== 'string' || path.basename(storedName) !== storedName) {
    throw new Error('添付ファイルの保存名が正しくありません。');
  }
  return path.join(uploadDirectory, storedName);
}
