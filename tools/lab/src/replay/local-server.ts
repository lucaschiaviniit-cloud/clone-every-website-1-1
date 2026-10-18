import { createServer,type IncomingMessage,type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname,join } from 'node:path';
import { safePath } from '../core/artifacts.js';
export const mimeFor=(path:string)=>({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml; charset=utf-8','.png':'image/png','.woff2':'font/woff2','.json':'application/json; charset=utf-8','.wasm':'application/wasm'}[extname(path)]??'application/octet-stream');
export type Handler=(req:IncomingMessage,res:ServerResponse)=>Promise<void>;
export async function localServer(handler:Handler,port=0) {
  const server=createServer((req,res)=>{handler(req,res).catch(error=>{res.statusCode=500;res.end('Local server error');console.error(error);});});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Server address missing');
  return {origin:`http://127.0.0.1:${address.port}`,close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
export async function fixtureServer(port=0) {
  return localServer(async(req,res)=>{
    if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    const url=new URL(req.url??'/','http://localhost');
    if(url.pathname==='/api/status'){res.setHeader('content-type','application/json');res.end(JSON.stringify({label:'GET replay OK',sequence:1}));return;}
    const path=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
    try{const bytes=await readFile(safePath(join(process.cwd(),'fixtures'),path));res.setHeader('content-type',mimeFor(path));res.end(bytes);}catch{res.writeHead(404);res.end('fixture not found');}
  },port);
}
