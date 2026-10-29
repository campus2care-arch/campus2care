import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const data=s=>"data:text/javascript;base64,"+Buffer.from(s).toString("base64");
const dbUrl=data(`import postgres from "${import.meta.resolve("postgres")}";const json=postgres().json;let values=[];let stored=[];export function providerAuthorizationEnabled(){return process.env.VERCEL_ENV==="preview"||(process.env.VERCEL_ENV==="production"&&process.env.INTERVIEW_PROVIDER_AUTH_ENABLED==="true")} export function writes(){return values} export function load(row){stored=[row];values=[]} export function providerCredentialDatabase(){return {json,unsafe:async(text,params)=>{if(text.startsWith('SELECT'))return stored;values.push(params);return []}}}`);
const source=ts.transpileModule(await readFile(new URL("../lib/interview-google-provider-auth.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace('from "./interview-provider-store"','from "'+dbUrl+'"');
const lib=await import(data(source)),db=await import(dbUrl);
const origin="https://preview.example.invalid",actor="president@campus2care.org";
function setup(){process.env.VERCEL_ENV="preview";delete process.env.INTERVIEW_PROVIDER_AUTH_ENABLED;process.env.INTERVIEW_BASE_URL=origin;process.env.INTERVIEW_AUTH_SECRET="synthetic-signing-secret-for-testing-only";process.env.INTERVIEW_TOKEN_ENCRYPTION_KEY=Buffer.alloc(32,7).toString("base64");process.env.INTERVIEW_GOOGLE_CLIENT_ID="synthetic-client";process.env.INTERVIEW_GOOGLE_CLIENT_SECRET="synthetic-client-secret";db.load(null)}
function grant(provider="calendar"){const value=lib.prepareProviderAuthorization(provider,origin,actor);return {...value,state:new URL(value.url).searchParams.get("state")}}
test("provider grants are preview-only and request offline access with PKCE",()=>{setup();const g=grant();const url=new URL(g.url);assert.equal(url.searchParams.get("login_hint"),"interviews@campus2care.org");assert.equal(url.searchParams.get("access_type"),"offline");assert.equal(url.searchParams.get("code_challenge_method"),"S256");assert.equal(url.searchParams.get("redirect_uri"),origin+lib.PROVIDER_CALLBACK);assert.ok(url.searchParams.get("scope").includes("calendar.events.owned"));assert.ok(!url.searchParams.get("scope").includes("gmail"));process.env.VERCEL_ENV="production";assert.throws(()=>grant(),/preview_only/)});
test("state rejects a different actor, a changed cookie, a wrong state and expiry",()=>{setup();const g=grant();assert.equal(lib.validateProviderState(g.cookie,g.state,actor).provider,"calendar");assert.throws(()=>lib.validateProviderState(g.cookie,g.state,"other@campus2care.org"));assert.throws(()=>lib.validateProviderState(g.cookie+"x",g.state,actor));assert.throws(()=>lib.validateProviderState(g.cookie,"wrong",actor));assert.throws(()=>lib.validateProviderState(g.cookie,g.state,actor,Date.now()+601000))});
test("refresh tokens are encrypted and reject ciphertext tampering or account swapping",()=>{setup();const sealed=lib.sealProviderToken("calendar","synthetic-refresh-token-value");assert.equal(lib.openProviderToken("calendar",sealed),"synthetic-refresh-token-value");assert.ok(!sealed.ciphertext.includes(Buffer.from("synthetic-refresh")));assert.throws(()=>lib.openProviderToken("gmail",sealed));const changed=Buffer.from(sealed.ciphertext);changed[0]^=1;assert.throws(()=>lib.openProviderToken("calendar",{...sealed,ciphertext:changed}))});
test("wrong Google account or incomplete permission never writes credentials",async()=>{setup();const g=grant();let calls=0;const transport=async()=>Response.json(++calls===1?{access_token:"synthetic-access-token",refresh_token:"synthetic-refresh-token",scope:lib.providerDetails("calendar").scopes.join(" ")}:{email:"contact@campus2care.org",email_verified:true});await assert.rejects(lib.completeProviderAuthorization({...g,actor,origin,code:"synthetic-code"},transport),/account_mismatch/);assert.equal(db.writes().length,0);await assert.rejects(lib.completeProviderAuthorization({...g,actor,origin,code:"synthetic-code"},async()=>Response.json({access_token:"synthetic-access-token",refresh_token:"synthetic-refresh-token",scope:"openid email"})),/scope_missing/);assert.equal(db.writes().length,0)});
test("successful consent stores encrypted credentials and refreshes server-side",async()=>{setup();const g=grant("gmail");let calls=0;const transport=async()=>Response.json(++calls===1?{access_token:"synthetic-access-token",refresh_token:"synthetic-refresh-token",scope:lib.providerDetails("gmail").scopes.join(" ")}:{email:"contact@campus2care.org",email_verified:true});assert.equal(await lib.completeProviderAuthorization({...g,actor,origin,code:"synthetic-code"},transport),"gmail");const row=db.writes()[0];assert.equal(row[0],"gmail");assert.equal(row[5].type,3802);assert.deepEqual(row[5].value,lib.providerDetails("gmail").scopes);assert.notEqual(row[2].toString(),"synthetic-refresh-token");db.load({account_email:row[1],ciphertext:row[2],iv:row[3],tag:row[4],granted_scopes:row[5].value});const access=await lib.googleProviderAccessToken("gmail",async(url,init)=>{assert.equal(new URLSearchParams(init.body).get("refresh_token"),"synthetic-refresh-token");return Response.json({access_token:"synthetic-refreshed-access-token"})});assert.equal(access,"synthetic-refreshed-access-token")});

test("missing or expired consent state is diagnosed before any provider call",()=>{setup();assert.throws(()=>lib.validateProviderState("","state",actor),/provider_state_missing/);const g=grant();assert.throws(()=>lib.validateProviderState(g.cookie,g.state,actor,Date.now()+601000),/provider_state_expired/)});

test("provider authorization rejects an origin different from the configured app",()=>{
 setup();assert.throws(()=>lib.prepareProviderAuthorization("gmail","https://other.invalid",actor),/untrusted_provider_origin/);
});


test("production consent uses approved scopes, encrypted production storage and a verified refresh identity",async()=>{
 setup();process.env.VERCEL_ENV="production";process.env.INTERVIEW_PROVIDER_AUTH_ENABLED="true";
 const g=grant();const scopes=lib.providerDetails("calendar").scopes;
 assert.deepEqual(scopes,["https://www.googleapis.com/auth/calendar.events","https://www.googleapis.com/auth/calendar.freebusy"]);
 let calls=0;
 await lib.completeProviderAuthorization({...g,actor,origin,code:"synthetic-code"},async()=>Response.json(++calls===1?
  {access_token:"synthetic-access-token",refresh_token:"synthetic-refresh-token",scope:scopes.join(" ")}:
  {email:"interviews@campus2care.org",email_verified:true}));
 const row=db.writes()[0];db.load({account_email:row[1],ciphertext:row[2],iv:row[3],tag:row[4],granted_scopes:row[5].value});
 calls=0;
 assert.equal(await lib.googleProviderAccessToken("calendar",async()=>Response.json(++calls===1?
  {access_token:"synthetic-refreshed-access-token"}:{email:"interviews@campus2care.org",email_verified:true})),"synthetic-refreshed-access-token");
 calls=0;
 await assert.rejects(lib.googleProviderAccessToken("calendar",async()=>Response.json(++calls===1?
  {access_token:"synthetic-refreshed-access-token"}:{email:"contact@campus2care.org",email_verified:true})),/account_mismatch/);
});
