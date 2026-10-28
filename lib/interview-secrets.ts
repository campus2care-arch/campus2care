import {createCipheriv,createDecipheriv,randomBytes} from "node:crypto";
type Sealed={ciphertext:string;iv:string;tag:string};
function key(){
  const value=process.env.INTERVIEW_TOKEN_ENCRYPTION_KEY??"";
  if(process.env.VERCEL_ENV!=="preview" || !/^[A-Za-z0-9+/]{43}=$/.test(value))throw new Error("interview_encryption_unavailable");
  return Buffer.from(value,"base64");
}
export function sealInterviewSecret(value:string,context:string):Sealed{
  const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key(),iv);cipher.setAAD(Buffer.from(context));
  return {ciphertext:Buffer.concat([cipher.update(value,"utf8"),cipher.final()]).toString("base64"),iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64")};
}
export function openInterviewSecret(value:Sealed,context:string):string{
  const cipher=createDecipheriv("aes-256-gcm",key(),Buffer.from(value.iv,"base64"));cipher.setAAD(Buffer.from(context));cipher.setAuthTag(Buffer.from(value.tag,"base64"));
  return Buffer.concat([cipher.update(Buffer.from(value.ciphertext,"base64")),cipher.final()]).toString("utf8");
}
