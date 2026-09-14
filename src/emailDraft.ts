import type { jsPDF } from "jspdf";

const utf8Base64 = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

const bytesBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

const fold = (value: string, width = 76) =>
  value.match(new RegExp(`.{1,${width}}`, "g"))?.join("\r\n") ?? "";
const encodedHeader = (value: string) => `=?UTF-8?B?${utf8Base64(value)}?=`;
export const safeFileName = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");

export function downloadOutlookDraft({
  to,
  subject,
  body,
  attachmentName,
  pdf,
}: {
  to: string;
  subject: string;
  body: string;
  attachmentName: string;
  pdf: jsPDF;
}) {
  const boundary = `movidos-${crypto.randomUUID()}`;
  const pdfBytes = new Uint8Array(pdf.output("arraybuffer"));
  const eml = [
    "X-Unsent: 1",
    `To: ${to.replace(/[\r\n]/g, "")}`,
    `Subject: ${encodedHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    fold(utf8Base64(body)),
    `--${boundary}`,
    `Content-Type: application/pdf; name="${attachmentName}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${attachmentName}"`,
    "",
    fold(bytesBase64(pdfBytes)),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([eml], { type: "message/rfc822" }));
  link.download = `${attachmentName.replace(/\.pdf$/i, "")}.eml`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
