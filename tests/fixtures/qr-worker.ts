import { qrPng, qrSvg } from "../../src/lib/qr.ts";
import { PDFDocument } from "pdf-lib";
export default { async fetch() {
  const png = await qrPng("nightshift-regression-token");
  const svg = await qrSvg("nightshift-regression-token");
  const doc = await PDFDocument.create();
  const qr = await doc.embedPng(png);
  doc.addPage([200,200]).drawImage(qr,{x:10,y:10,width:180,height:180});
  const pdf = await doc.save();
  return Response.json({png: png.subarray(0,8).toString("hex"), width:qr.width, svg:svg.startsWith("<svg"), pdf:pdf.length});
}};
