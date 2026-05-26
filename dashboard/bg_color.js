const fs = require('fs');
const html = fs.readFileSync('/tmp/yc.html', 'utf8');
const match = html.match(/--beige-light:\s*([^;]+);/);
if (match) console.log("Found CSS variable:", match[1]);
else {
  // Let's try to extract `<style>` tags to find beige-light
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/g);
  if (styleMatch) {
     styleMatch.forEach(s => {
        const bgMatch = s.match(/\.bg-beige-light\s*\{\s*background-color:\s*([^;}]+)/i);
        if (bgMatch) console.log("Found in style:", bgMatch[1]);
     });
  }
}
