import { CourseData, CELL } from '../src/world/course';
import sharp from 'sharp';
const t0 = performance.now();
const c = new CourseData();
console.log('build ms', (performance.now()-t0).toFixed(0), 'grid', c.NX, c.NZ, 'len', c.length, 'finish', c.finishS, 'summit', c.summitS, 'hillTop', c.hillTop.toFixed(1));
console.log('checkpoints', c.checkpoints.map(k=>k.s).join(','));
console.log('counts', {hay:c.hay.length,cones:c.cones.length,pot:c.potholes.length,boulders:c.boulders.length,trees:c.trees.length,pines:c.pines.length,bushes:c.bushes.length,rocks:c.rocks.length,tufts:c.tufts.length,houses:c.houses.length,fences:c.fences.length});
// slope profile along track
let maxG=0, maxS=0;
for (let s=0;s<c.length-4;s+=2){const a=c.track.pointAt(s),b=c.track.pointAt(s+2);const g=Math.atan((b.y-a.y)/2)*57.3; if(Math.abs(g)>Math.abs(maxG)&&s<c.hillStartS){maxG=g;maxS=s;}}
console.log('max grade before hill', maxG.toFixed(1), 'at', maxS);
for (let s=c.hillStartS-10;s<=c.length;s+=10){const a=c.track.pointAt(s),b=c.track.pointAt(Math.min(c.length,s+2));console.log(' hill s',s,'y',a.y.toFixed(1),'deg',(Math.atan((b.y-a.y)/2)*57.3).toFixed(1), c.surfaceAt(a.x,a.z));}
const surfAlong:Record<string,number>={}; for(let s=0;s<c.length;s+=2){const p=c.track.pointAt(s);const k=c.zoneAt(s).id+':'+c.surfaceAt(p.x,p.z);surfAlong[k]=(surfAlong[k]||0)+2;} console.log(surfAlong);
// image: height + surface
const W=c.NX,H=c.NZ; const img=Buffer.alloc(W*H*3);
let mn=1e9,mx=-1e9; for(const h of c.heights){mn=Math.min(mn,h);mx=Math.max(mx,h);} console.log('h range',mn.toFixed(1),mx.toFixed(1));
const col:any={asphalt:[60,60,60],dirt:[150,110,70],gravel:[170,170,160],mud:[80,50,20],sand:[230,200,130],water:[40,110,230]};
for(let i=0;i<H;i++)for(let j=0;j<W;j++){const x=c.x0+j*CELL,z=c.z0+i*CELL;const h=c.heights[i+j*H];const sf=c.surfaceAt(x,z);const k=((H-1-i)*W+(W-1-j))*3;const base=col[sf];const sh=0.5+0.5*(h-mn)/(mx-mn);
 const d=c.dist[i+j*H]; const green = sf==='dirt' && d>c.halfWidthAt(c.nearS[i+j*H])+1;
 const cc = green?[70,140,60]:base; img[k]=cc[0]*sh;img[k+1]=cc[1]*sh;img[k+2]=cc[2]*sh;}
await sharp(img,{raw:{width:W,height:H,channels:3}}).png().toFile(process.argv[2]);
