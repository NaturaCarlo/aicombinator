const fs = require('fs');
const { JSDOM } = require('jsdom');
const dom = new JSDOM(fs.readFileSync('/tmp/yc.html', 'utf8'));
const doc = dom.window.document;

// We need to find the "in-the-room-photos" section or similar
const section = doc.querySelector('#in-the-room-photos');
if (section) {
  const images = Array.from(section.querySelectorAll('img')).map(img => img.src);
  console.log(images.join('\n'));
} else {
  // Let's try finding the image container by looking for the grid with aspect ratio classes
  const grids = Array.from(doc.querySelectorAll('div')).filter(d => d.className.includes('aspect-[4/5]') && d.innerHTML.includes('<img'));
  grids.forEach(g => {
     const img = g.querySelector('img');
     if (img) console.log(img.src);
  });
}
