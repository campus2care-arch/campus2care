import test from "node:test";
import assert from "node:assert/strict";
import {loadInterviewModule} from "./interview-test-loader.mjs";

test("negative and non-finite durations never reach AbortSignal.timeout",()=>{
  const mod=loadInterviewModule("interview-abort-timeout");
  const seen=[];
  const original=AbortSignal.timeout;
  AbortSignal.timeout=function(ms){seen.push(ms);return original.call(AbortSignal,ms);};
  try{
    for(const value of [-1,-0.2,Number.NaN,Number.POSITIVE_INFINITY,0]){
      const signal=mod.boundedAbortSignal(value);
      assert.equal(signal.aborted,true);
      assert.equal(signal.reason?.name,"TimeoutError");
    }
    const live=mod.boundedAbortSignal(1500.9);
    assert.equal(live.aborted,false);
    assert.deepEqual(seen,[1500]);
  }finally{AbortSignal.timeout=original;}
});
