import koffi from 'koffi';

// Windows DPAPI (CryptProtectData / CryptUnprotectData), CurrentUser scope.
// A blob protected here can only be decrypted by the same Windows user on this PC.

const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
const ENTROPY = Buffer.from('DataCrawlStudio.secrets.v1', 'utf8');

type NativeFn = ReturnType<ReturnType<typeof koffi.load>['func']>;

interface Api {
  protect: NativeFn;
  unprotect: NativeFn;
  localFree: NativeFn;
}

let api: Api | null = null;

function load(): Api {
  if (api) return api;
  if (process.platform !== 'win32') throw new Error('DPAPI is only available on Windows');
  const crypt32 = koffi.load('crypt32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  koffi.struct('DCS_DATA_BLOB', { cbData: 'uint32', pbData: 'void *' });
  const protect = crypt32.func(
    'bool __stdcall CryptProtectData(DCS_DATA_BLOB *pDataIn, const char16_t *szDataDescr, DCS_DATA_BLOB *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32 dwFlags, _Out_ DCS_DATA_BLOB *pDataOut)',
  );
  const unprotect = crypt32.func(
    'bool __stdcall CryptUnprotectData(DCS_DATA_BLOB *pDataIn, void *ppszDataDescr, DCS_DATA_BLOB *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32 dwFlags, _Out_ DCS_DATA_BLOB *pDataOut)',
  );
  const localFree = kernel32.func('void * __stdcall LocalFree(void *hMem)');
  api = { protect, unprotect, localFree };
  return api;
}

function call(fn: 'protect' | 'unprotect', input: Buffer): Buffer {
  const a = load();
  const inBlob = { cbData: input.length, pbData: input };
  const entropy = { cbData: ENTROPY.length, pbData: ENTROPY };
  const out: { cbData?: number; pbData?: unknown } = {};
  const ok =
    fn === 'protect'
      ? a.protect(inBlob, 'DataCrawlStudio', entropy, null, null, CRYPTPROTECT_UI_FORBIDDEN, out)
      : a.unprotect(inBlob, null, entropy, null, null, CRYPTPROTECT_UI_FORBIDDEN, out);
  if (!ok || !out.pbData || out.cbData === undefined) {
    throw new Error(`DPAPI ${fn} failed`);
  }
  try {
    const bytes = koffi.decode(out.pbData, koffi.array('uint8', out.cbData, 'Typed')) as Uint8Array;
    return Buffer.from(bytes);
  } finally {
    a.localFree(out.pbData);
  }
}

export function dpapiProtect(plain: Buffer): Buffer {
  return call('protect', plain);
}

export function dpapiUnprotect(blob: Buffer): Buffer {
  return call('unprotect', blob);
}
