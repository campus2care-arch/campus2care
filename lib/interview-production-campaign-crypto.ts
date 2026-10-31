import {createCipheriv,createDecipheriv,randomBytes} from "node:crypto";
export type SealedCampaignToken={iv:string;tag:string;ciphertext:string};
function secretKey(){
  const raw=process.env.INTERVIEW_TOKEN_ENCRYPTION_KEY??"";
  if(process.env.VERCEL_ENV!=="production"||
     process.env.INTERVIEW_DATA_ENV!=="production"||
     !/^[A-Za-z0-9+/]{43}=$/.test(raw))
    throw Error("campaign_token_encryption_not_configured");
  const key=Buffer.from(raw,"base64");
  if(key.length!==32)throw Error("campaign_token_encryption_not_configured");
  return key;
}
/** Token never stored in plaintext or logged; it is tied to one campaign op. */
export function sealProductionCampaignToken(token:string,operationKey:string):SealedCampaignToken{
  if(!/^[A-Za-z0-9_-]{40,80}$/.test(token)||operationKey.length>160||operationKey.length<25)
    throw Error("campaign_token_invalid");
  const iv=randomBytes(12), cipher=createCipheriv("aes-256-gcm",secretKey(),iv);
  cipher.setAAD(Buffer.from(operationKey));
  const ciphertext=Buffer.concat([cipher.update(token,"utf8"),cipher.final()]);
  return {iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),
    ciphertext:ciphertext.toString("base64")};
}
export function openProductionCampaignToken(sealed:SealedCampaignToken,operationKey:string){
  const decipher=createDecipheriv("aes-256-gcm",secretKey(),Buffer.from(sealed.iv,"base64"));
  decipher.setAAD(Buffer.from(operationKey));
  decipher.setAuthTag(Buffer.from(sealed.tag,"base64"));
  const token=Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext,"base64")),decipher.final()]).toString("utf8");
  if(!/^[A-Za-z0-9_-]{40,80}$/.test(token))throw Error("campaign_token_invalid");
  return token;
}
