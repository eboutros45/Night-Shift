// Pin the Node renderer: Worker bundling otherwise selects the canvas-only browser entry.
import QRCode from "qrcode/lib/server.js";

// The QR holds only the 22-char ticket token: nothing personal, nothing guessable.
const opts = { errorCorrectionLevel: "M", margin: 2 } as const;

export const qrSvg = (token: string) => QRCode.toString(token, { ...opts, type: "svg" });
export const qrPng = (token: string) => QRCode.toBuffer(token, { ...opts, type: "png", width: 600 });
