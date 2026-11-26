import { zipSync, strToU8 } from 'fflate';
const CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
export const W = (body) => `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
export const cell = (t, props = '') => `<w:tc>${props ? `<w:tcPr>${props}</w:tcPr>` : ''}<w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
export const tbl = (rows) => `<w:tbl>${rows.map((r) => `<w:tr>${r.join('')}</w:tr>`).join('')}</w:tbl>`;
export const buildDocx = ({ body, extra = {}, ct = CT } = {}) => Buffer.from(zipSync({ '[Content_Types].xml': strToU8(ct), 'word/document.xml': strToU8(body), ...extra }, { level: 9 }));
