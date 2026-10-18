// Serve only bytes actually captured. A recorded 206 can be treated as a full
// representation only when Content-Range proves it contains bytes 0..total-1.
export function mediaRange(body:Buffer,status:number,contentRange:string|undefined,range:string|undefined) {
  const recorded=contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  const complete=status===200||(status===206&&!!recorded&&Number(recorded[1])===0&&Number(recorded[2])+1===Number(recorded[3])&&Number(recorded[3])===body.length);
  if(!complete)return {body,status,contentRange};
  if(!range)return {body,status:200,contentRange:undefined};
  const parsed=range.match(/^bytes=(\d*)-(\d*)$/);
  if(!parsed||(!parsed[1]&&!parsed[2]))return {body:Buffer.alloc(0),status:416,contentRange:`bytes */${body.length}`};
  const start=parsed[1]?Number(parsed[1]):Math.max(0,body.length-Number(parsed[2]));
  const end=parsed[1]&&parsed[2]?Math.min(Number(parsed[2]),body.length-1):body.length-1;
  if(start> end||start>=body.length)return {body:Buffer.alloc(0),status:416,contentRange:`bytes */${body.length}`};
  return {body:body.subarray(start,end+1),status:206,contentRange:`bytes ${start}-${end}/${body.length}`};
}
