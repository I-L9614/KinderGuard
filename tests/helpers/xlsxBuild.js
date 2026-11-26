import { zipSync, strToU8 } from 'fflate';
export const CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
const WB = (sheets) => `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${s.name || `S${i + 1}`}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
const RELS = (n) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
export const SHEET = (rows) => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
export const build = ({ sheets = [{}], sheetXml = [SHEET('<row r="1"><c r="A1" t="inlineStr"><is><t>שם</t></is></c><c r="B1" t="inlineStr"><is><t>טלפון</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>גן אלון</t></is></c><c r="B2"><v>5551234</v></c></row>')], extra = {}, ct = CT, sst } = {}) => {
  const files = { '[Content_Types].xml': strToU8(ct), 'xl/workbook.xml': strToU8(WB(sheets)), 'xl/_rels/workbook.xml.rels': strToU8(RELS(sheets.length)), ...extra };
  sheetXml.forEach((x, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(x); });
  if (sst) files['xl/sharedStrings.xml'] = strToU8(sst);
  return Buffer.from(zipSync(files, { level: 9 }));
};
