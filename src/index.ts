import { DefaultAzureCredential } from '@azure/identity';
import {
  AnonymousCredential,
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  newPipeline,
  PublicAccessType,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import * as path from 'path';
import internal from 'stream';
import { v4 as uuidv4 } from 'uuid';

type CommonConfig = {
  account: string;
  serviceBaseURL?: string;
  containerName: string;
  defaultPath: string;
  cdnBaseURL?: string;
  defaultCacheControl?: string;
  createContainerIfNotExist?: string;
  publicAccessType?: PublicAccessType;
  removeCN?: string;
  uploadOptions?: {
    bufferSize: number;
    maxBuffers: number;
  };
};

type Config = DefaultConfig | ManagedIdentityConfig;

type DefaultConfig = CommonConfig & {
  authType: 'default';
  accountKey: string;
  sasToken: string;
};

type ManagedIdentityConfig = CommonConfig & {
  authType: 'msi';
  clientId?: string;
};

type StrapiFile = File & {
  stream: internal.Readable;
  hash: string;
  url: string;
  ext: string;
  mime: string;
  path: string;
};

function hackCustomFilename(file: StrapiFile) {
  const fileName = file.name.replace(/@/g, '/');

  const parsedPath = path.parse(fileName);
  const uuid = uuidv4();

  const newFileName = `${parsedPath.name}_${uuid}`;
  const newFilePath = path.join(parsedPath.dir, newFileName);

  file.hash = newFilePath;
}

function trimParam(input?: string) {
  return typeof input === 'string' ? input.trim() : '';
}

function getServiceBaseUrl(config: Config) {
  return (
    trimParam(config.serviceBaseURL) || `https://${trimParam(config.account)}.blob.core.windows.net`
  );
}

function getFileName(path: string, file: StrapiFile) {
  return `${trimParam(path)}/${file.hash}${file.ext}`;
}

function makeBlobServiceClient(config: Config) {
  const serviceBaseURL = getServiceBaseUrl(config);

  switch (config.authType) {
    case 'default': {
      const account = trimParam(config.account);
      const accountKey = trimParam(config.accountKey);
      const sasToken = trimParam(config.sasToken);
      if (sasToken != '') {
        const anonymousCredential = new AnonymousCredential();
        return new BlobServiceClient(`${serviceBaseURL}${sasToken}`, anonymousCredential);
      }
      const sharedKeyCredential = new StorageSharedKeyCredential(account, accountKey);
      const pipeline = newPipeline(sharedKeyCredential);
      return new BlobServiceClient(serviceBaseURL, pipeline);
    }
    case 'msi': {
      const clientId = trimParam(config.clientId);
      if (clientId != null && clientId != '') {
        return new BlobServiceClient(
          serviceBaseURL,
          new DefaultAzureCredential({ managedIdentityClientId: clientId })
        );
      }
      return new BlobServiceClient(serviceBaseURL, new DefaultAzureCredential());
    }
    default: {
      const exhaustiveCheck: never = config;
      throw new Error(exhaustiveCheck);
    }
  }
}

const uploadOptions: CommonConfig['uploadOptions'] = {
  bufferSize: 4 * 1024 * 1024, // 4MB
  maxBuffers: 20,
};

async function handleSignedUrl(config: DefaultConfig, file: StrapiFile): Promise<string> {
  const account = trimParam(config.account);
  const accountKey = trimParam(config.accountKey);
  const cerds = new StorageSharedKeyCredential(account, accountKey);
  const blobSvcClient = new BlobServiceClient(`https://${account}.blob.core.windows.net`, cerds);
  const client = blobSvcClient.getContainerClient(trimParam(config.containerName));

  const blobName = getFileName(config.defaultPath, file);
  const blobClient = client.getBlobClient(blobName);

  const blobSAS = generateBlobSASQueryParameters(
    {
      containerName: config.containerName,
      blobName,
      permissions: BlobSASPermissions.parse('r'),
      startsOn: new Date(),
      expiresOn: new Date(new Date().valueOf() + 86400),
    },
    cerds
  ).toString();

  const sasUrl = blobClient.url + '?' + blobSAS;

  return sasUrl;
}

async function handleUpload(
  config: Config,
  blobSvcClient: BlobServiceClient,
  file: StrapiFile
): Promise<void> {
  const serviceBaseURL = getServiceBaseUrl(config);
  const containerClient = blobSvcClient.getContainerClient(trimParam(config.containerName));
  const client = containerClient.getBlockBlobClient(getFileName(config.defaultPath, file));

  if (trimParam(config?.createContainerIfNotExist) === 'true') {
    if (
      trimParam(config?.publicAccessType) === 'container' ||
      trimParam(config?.publicAccessType) === 'blob'
    ) {
      await containerClient.createIfNotExists({
        access: config.publicAccessType,
      });
    } else {
      await containerClient.createIfNotExists();
    }
  }

  const options = {
    blobHTTPHeaders: {
      blobContentType: file.mime,
      blobCacheControl: trimParam(config.defaultCacheControl),
    },
  };

  const cdnBaseURL = trimParam(config.cdnBaseURL);
  file.url = cdnBaseURL ? client.url.replace(serviceBaseURL, cdnBaseURL) : client.url;
  if (
    file.url.includes(`/${config.containerName}/`) &&
    config.removeCN &&
    config.removeCN == 'true'
  ) {
    file.url = file.url.replace(`/${config.containerName}/`, '/');
  }

  await client.uploadStream(
    file.stream,
    config.uploadOptions?.bufferSize || uploadOptions?.bufferSize,
    config.uploadOptions?.maxBuffers || uploadOptions?.maxBuffers,
    options
  );
}

async function handleDelete(
  config: Config,
  blobSvcClient: BlobServiceClient,
  file: StrapiFile
): Promise<void> {
  const containerClient = blobSvcClient.getContainerClient(trimParam(config.containerName));
  const client = containerClient.getBlobClient(getFileName(config.defaultPath, file));
  await client.delete();
  file.url = client.url;
}

module.exports = {
  provider: 'azure',
  auth: {
    authType: {
      label: 'Authentication type (required, either "msi" or "default")',
      type: 'text',
    },
    clientId: {
      label:
        'Azure Identity ClientId (consumed if authType is "msi" and passed as DefaultAzureCredential({ managedIdentityClientId: clientId }))',
      type: 'text',
    },
    account: {
      label: 'Account name (required)',
      type: 'text',
    },
    accountKey: {
      label: 'Secret access key (required if authType is "default")',
      type: 'text',
    },
    serviceBaseURL: {
      label:
        'Base service URL to be used, optional. Defaults to https://${account}.blob.core.windows.net (optional)',
      type: 'text',
    },
    containerName: {
      label: 'Container name (required)',
      type: 'text',
    },
    createContainerIfNotExist: {
      label: 'Create container on upload if it does not (optional)',
      type: 'text',
    },
    publicAccessType: {
      label:
        'If createContainerIfNotExist is true, set the public access type to one of "blob" or "container" (optional)',
      type: 'text',
    },
    cdnBaseURL: {
      label: 'CDN base url (optional)',
      type: 'text',
    },
    defaultCacheControl: {
      label: 'Default cache-control setting for all uploaded files',
      type: 'text',
    },
    removeCN: {
      label: 'Remove container name from URL (optional)',
      type: 'text',
    },
  },
  init: (config: Config) => {
    const blobSvcClient = makeBlobServiceClient(config);
    return {
      async upload(file: StrapiFile) {
        hackCustomFilename(file);
        return handleUpload(config, blobSvcClient, file);
      },
      async uploadStream(file: StrapiFile) {
        hackCustomFilename(file);
        return handleUpload(config, blobSvcClient, file);
      },
      async delete(file: StrapiFile) {
        return handleDelete(config, blobSvcClient, file);
      },
      async isPrivate() {
        return true;
      },
      async getSignedUrl(file: StrapiFile) {
        const signedUrl = await handleSignedUrl(config as DefaultConfig, file);
        return { url: signedUrl };
      },
    };
  },
};
