import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";

const {applySelectedFounderExceptions}=loadInterviewModule("interview-founder-follow-up-exceptions");
const candidates=[
 {campus:"BC",pageId:"recent1",frequencyLimited:true},
 {campus:"BU",pageId:"recent2",frequencyLimited:true},
 {campus:"BU",pageId:"fresh",frequencyLimited:false},
 {campus:"BC",pageId:"unselected",frequencyLimited:true},
];
const key=c=>c.campus+":"+c.pageId;

test("bulk exceptions only check selected recently contacted applicants",()=>{
 const selected=new Set(candidates.slice(0,3).map(key));
 const old=new Set(["BU:previous"]);
 const next=applySelectedFounderExceptions(candidates,selected,old);
 assert.deepEqual([...next].sort(),["BC:recent1","BU:previous","BU:recent2"].sort());
 assert.deepEqual([...old],["BU:previous"],"original selection is not mutated");
});

test("bulk exceptions are idempotent and do not invent exceptions on an empty selection",()=>{
 const selection=new Set(candidates.slice(0,2).map(key));
 const once=applySelectedFounderExceptions(candidates,selection,new Set());
 const twice=applySelectedFounderExceptions(candidates,selection,once);
 assert.deepEqual([...once].sort(),[...twice].sort());
 const empty=applySelectedFounderExceptions(candidates,new Set(),new Set());
 assert.equal(empty.size,0);
});

test("only candidates supplied by the server can gain a bulk exception",()=>{
 const selected=new Set(["BC:unlisted","BC:recent1"]);
 const next=applySelectedFounderExceptions(candidates,selected,new Set());
 assert.deepEqual([...next],["BC:recent1"]);
});
