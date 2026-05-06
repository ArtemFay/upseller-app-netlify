// Дёргаем handler напрямую без HTTP, в том же процессе.
import sheetsClient from './web/api/_lib/invent/sheets-client.js';

const tests = [
  'Позоян А.Р.',
  'Позоян А.Р. ', // с trailing space
  'Позоян А.Р. ', // NBSP
  ' Позоян А.Р.', // leading space
];

for (const t of tests) {
  const r = await sheetsClient.getClientBarcodes(t);
  console.log(`input: ${JSON.stringify(t)} (${[...t].map(c=>c.charCodeAt(0)).join(',')}) → ${r.length} результатов`);
}
