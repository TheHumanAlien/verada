import { Bee } from "@ethersphere/bee-js";

export interface UploadOpts {
  beeUrl: string;
  batchId: string;
  dir: string;
  /** Served at the collection root; omitted for asset packs. */
  indexDocument?: string;
  errorDocument?: string;
  pin: boolean;
}

/** Real upload. Only reached with an explicit --execute. The batch id is a public identifier, not a key. */
export async function uploadDirectory(o: UploadOpts): Promise<string> {
  const bee = new Bee(o.beeUrl);
  const res = await bee.uploadFilesFromDirectory(o.batchId, o.dir, {
    indexDocument: o.indexDocument,
    errorDocument: o.errorDocument,
    pin: o.pin,
  });
  return res.reference.toHex();
}
