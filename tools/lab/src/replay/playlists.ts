import { resourcePath } from '../reconstruction/builders.js';

/** URL identity is essential: identical bodies can resolve to different segments. */
export function adaptPlaylist(text:string,playlistUrl:string,sourceOrigin:string) {
  const local=(raw:string)=>{
    try{const url=new URL(raw,playlistUrl);return ['http:','https:'].includes(url.protocol)?resourcePath(url.href,sourceOrigin):raw;}catch{return raw;}
  };
  return text.split(/(\r?\n)/).map(line=>{
    if(line.startsWith('#'))return line.replace(/\bURI="([^"]*)"/g,(_all,uri)=>`URI="${local(uri)}"`);
    if(!line.trim())return line;
    return line.replace(/\S+/,value=>local(value));
  }).join('');
}
