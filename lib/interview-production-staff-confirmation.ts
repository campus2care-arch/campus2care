import {createHash} from "node:crypto";
import {productionCanaryConfig} from "./interview-production-canary";
import {
  CampaignGmailError,classifyCampaignDeliveryError,classifyGmailHttpStatus,
  safeCampaignErrorCode,type CampaignGmailFailure,
} from "./interview-campaign-gmail-disposition";
import {safeApplicantFirstName} from "./interview-email";
import {renderInterviewMessage} from "./interview-email";
import {productionRealConfig,productionRealEnabled} from "./interview-production-launch";
import {productionGoogleAccessToken} from "./interview-production-providers";

const GMAIL_SEND="https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function staffConfirmationsApproved(env:Record<string,string|undefined>=process.env){
  return env.INTERVIEW_REAL_STAFF_CONFIRMATIONS_APPROVED==="true";
}

export function staffConfirmationOperationKey(reservationId:string,interviewerId:string){
  return "interview-staff-confirmation:"+reservationId+":"+interviewerId;
}

/** Same classes as campaign Gmail, with staff-confirmation codes. Never an ambiguous hold for pre-send failures. */
export function classifyStaffConfirmationDeliveryError(error:unknown):CampaignGmailFailure{
  const failure=classifyCampaignDeliveryError(error);
  const renamed=failure.code.startsWith("campaign_")
    ? "staff_confirmation_"+failure.code.slice("campaign_".length)
    : failure.code;
  const code=safeCampaignErrorCode(renamed);
  return {...failure,code:code==="campaign_gmail_outcome_uncertain"?"staff_confirmation_gmail_outcome_uncertain":code};
}

/** Counts and error class only. No recipient, invite token, Meet URL, or applicant name. */
export function logStaffConfirmationOutcome(status:{
  code:string; errorClass:string; httpStatus:number|null; disposition:string;
}){
  const code=/^[a-z][a-z0-9_]{0,80}$/.test(status.code)?status.code:"staff_confirmation_gmail_outcome_uncertain";
  console.info(JSON.stringify({
    event:"staff_confirmation_gmail",
    code:code==="campaign_gmail_outcome_uncertain"?"staff_confirmation_gmail_outcome_uncertain":code,
    errorClass:/^[a-z][a-z0-9_]{0,40}$/.test(status.errorClass)?status.errorClass:"outcome_uncertain",
    httpStatus:typeof status.httpStatus==="number"&&status.httpStatus>=100&&status.httpStatus<=599?status.httpStatus:null,
    disposition:["sent","fail","requeue","uncertain"].includes(status.disposition)?status.disposition:"uncertain",
  }));
}

export type StaffBookingConfirmation={
  operationKey:string; reservationId:string; interviewerId:string; email:string;
  campus:"BU"|"BC"; startsAt:string; applicantFirstName:string; role:"lead"|"shadow";
};

function deliveryInvalid(code="staff_confirmation_delivery_invalid"):never{
  throw new CampaignGmailError({code,errorClass:"config",httpStatus:null,disposition:"fail"});
}

function assertDeliveryConfigured(){
  try{
    if(productionRealEnabled())productionRealConfig();
    else productionCanaryConfig();
  }catch(error){
    const message=error instanceof Error?error.message:"";
    if(message==="interview_production_real_disabled"||message==="interview_production_canary_disabled"||
      message==="interview_production_database_invalid"){
      throw new CampaignGmailError({code:"staff_confirmation_not_configured",errorClass:"config",
        httpStatus:null,disposition:"fail"});
    }
    throw error;
  }
}

/** contact@ notice for the lead and attached shadows. The calendar invite carries the Meet link. */
export async function sendProductionStaffBookingConfirmation(
  input:StaffBookingConfirmation,transport:typeof fetch=fetch,
){
  if(!staffConfirmationsApproved())deliveryInvalid("staff_confirmation_not_approved");
  const firstName=safeApplicantFirstName(input.applicantFirstName);
  const expected=staffConfirmationOperationKey(input.reservationId,input.interviewerId);
  if(!UUID.test(input.reservationId)||!UUID.test(input.interviewerId)||input.operationKey!==expected||
    !["BU","BC"].includes(input.campus)||(input.role!=="lead"&&input.role!=="shadow")||!firstName||
    !/^[a-z0-9._%+-]+@campus2care\.org$/i.test(input.email)||
    !Number.isFinite(Date.parse(input.startsAt)))
    deliveryInvalid();
  assertDeliveryConfigured();
  let view:{subject:string;text:string;html:string};
  try{
    view=renderInterviewMessage({
      operationKey:input.operationKey,recipient:input.email,kind:"confirmation",campus:input.campus,
      startsAt:input.startsAt,appointmentRole:input.role,applicantFirstName:firstName,
    });
  }catch{deliveryInvalid();}
  let access:string;
  try{access=await productionGoogleAccessToken("gmail",transport);}
  catch(error){throw new CampaignGmailError(classifyStaffConfirmationDeliveryError(error));}
  const hash=createHash("sha256").update(input.operationKey).digest("hex");
  const boundary="c2c_"+hash;
  const mime=[
    "From: Campus2Care <contact@campus2care.org>","To: "+input.email,
    "Reply-To: contact@campus2care.org","Subject: "+view.subject,
    "Message-ID: <"+hash+"@campus2care.org>","MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="'+boundary+'"',"",
    "--"+boundary,'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64","",Buffer.from(view.text).toString("base64"),
    "--"+boundary,'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64","",Buffer.from(view.html).toString("base64"),
    "--"+boundary+"--","",
  ].join("\r\n");
  let response:Response;
  try{response=await transport(GMAIL_SEND,{
    method:"POST",headers:{Authorization:"Bearer "+access,"Content-Type":"application/json"},
    body:JSON.stringify({raw:Buffer.from(mime).toString("base64url")}),
    cache:"no-store",signal:AbortSignal.timeout(10000),
  });}catch(error){
    const name=error instanceof Error?error.name:"";
    throw new CampaignGmailError({
      code:"staff_confirmation_gmail_outcome_uncertain",
      errorClass:name==="TimeoutError"||name==="AbortError"?"timeout":"network",
      httpStatus:null,disposition:"uncertain",
    });
  }
  if(!response.ok){
    throw new CampaignGmailError(classifyStaffConfirmationDeliveryError(
      new CampaignGmailError(classifyGmailHttpStatus(response.status))));
  }
  let result:{id?:unknown};
  try{result=await response.json() as {id?:unknown};}
  catch{throw new CampaignGmailError({code:"staff_confirmation_gmail_outcome_uncertain",errorClass:"invalid_acceptance",httpStatus:response.status,disposition:"uncertain"});}
  if(typeof result.id!=="string"||!/^[A-Za-z0-9_-]{5,200}$/.test(result.id))
    throw new CampaignGmailError({code:"staff_confirmation_gmail_outcome_uncertain",errorClass:"invalid_acceptance",httpStatus:response.status,disposition:"uncertain"});
  return result.id;
}
