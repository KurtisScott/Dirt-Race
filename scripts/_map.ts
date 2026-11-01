import { buildCourseLine } from '../src/world/layout';
import sharp from 'sharp';
const c = buildCourseLine(2);
let minx=1e9,maxx=-1e9,minz=1e9,maxz=-1e9;
for (let i=0;i<c.xs.length;i++){minx=Math.min(minx,c.xs[i]);maxx=Math.max(maxx,c.xs[i]);minz=Math.min(minz,c.zs[i]);maxz=Math.max(maxz,c.zs[i]);}
console.log({len:c.length, minx,maxx,minz,maxz, zones:c.zones.map(z=>`${z.id}:${z.startS}-${z.endS}`).join(' ')});
const pad=60, W=maxx-minx+2*pad, H=maxz-minz+2*pad, sc=900/Math.max(W,H);
const col:any={town:'#555',farm:'#a5682a',mud:'#4a3015',rocky:'#999',desert:'#e0c070',river:'#3080ff',finish:'#0a0',hill:'#f00'};
let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W*sc}" height="${H*sc}"><rect width="100%" height="100%" fill="#cde"/>`;
for (const z of c.zones){ let d=''; for (let s=z.startS;s<=z.endS;s+=2){const i=Math.round(s/2); if(i>=c.xs.length)break; const X=(maxx+pad-c.xs[i])*sc, Y=(maxz+pad-c.zs[i])*sc; d+=(d?'L':'M')+X.toFixed(1)+','+Y.toFixed(1);} svg+=`<path d="${d}" stroke="${col[z.id]}" stroke-width="${12*sc}" fill="none"/>`;}
for (let s=0;s<c.length;s+=300){const i=s/2;svg+=`<text x="${(maxx+pad-c.xs[i])*sc}" y="${(maxz+pad-c.zs[i])*sc}" font-size="14">${s}</text>`;}
svg+='</svg>';
await sharp(Buffer.from(svg)).png().toFile(process.argv[2]);
