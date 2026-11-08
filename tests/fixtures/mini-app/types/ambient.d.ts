// Ambient stand-ins for external packages so the fixture compiles without installing anything.
declare module 'mini-sdk' {
  export class StorageClient {
    constructor(options: { region: string });
    putObject(key: string, body: string): Promise<{ etag: string }>;
  }
}
declare module 'axios' {
  const axios: { post(url: string, body: unknown): Promise<{ data: unknown }> };
  export default axios;
}
