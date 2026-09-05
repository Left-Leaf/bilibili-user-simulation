declare module 'qrcode-terminal' {
  export interface QrGenerateOptions {
    small?: boolean;
  }
  export function generate(text: string, options?: QrGenerateOptions): void;
  export function generate(text: string, callback: (qr: string) => void): void;
  export function generate(text: string, options: QrGenerateOptions, callback: (qr: string) => void): void;
  export function setErrorLevel(level: string): void;
  const qrcodeTerminal: {
    generate: typeof generate;
    setErrorLevel: typeof setErrorLevel;
  };
  export default qrcodeTerminal;
}
