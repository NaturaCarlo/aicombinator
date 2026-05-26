const fs = require('fs');
const { JSDOM } = require('jsdom');
const dom = new JSDOM(fs.readFileSync('/tmp/yc.html', 'utf8'));
const doc = dom.window.document;

// Remove SVGs and Scripts
doc.querySelectorAll('svg').forEach(el => el.replaceWith('[SVG]'));
doc.querySelectorAll('script').forEach(el => el.remove());

const sections = Array.from(doc.querySelectorAll('section'));
sections.forEach((sec, i) => {
  // get class and first few text contents
  console.log(`\n--- SECTION ${i} ---`);
  console.log('CLASS:', sec.className);
  console.log('TEXT:', sec.textContent.replace(/\s+/g, ' ').substring(0, 200).trim());
});

