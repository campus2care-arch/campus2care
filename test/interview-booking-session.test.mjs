import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInterviewModule} from './interview-test-loader.mjs';
const {interviewSessionToken}=loadInterviewModule('interview-booking-session');
test('scrubbed URLs still work after refresh, with separate per-mode tab storage',()=>{
 const memory=new Map(),storage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)};
 assert.equal(interviewSessionToken('','#token=first',storage,'production'),'first');
 assert.equal(interviewSessionToken('','',storage,'production'),'first');
 assert.equal(interviewSessionToken('','',storage,'synthetic'),'');
 assert.equal(interviewSessionToken('?token=new','#token=latest',storage,'production'),'latest');
 assert.equal(interviewSessionToken('','',storage,'production'),'latest');
 assert.equal(interviewSessionToken('','',null,'production'),'');
});
test('a browser denying storage still accepts an original emailed link',()=>{
 const denied={getItem:()=>{throw Error('denied');},setItem:()=>{throw Error('denied');}};
 assert.equal(interviewSessionToken('?token=original','',denied,'production'),'original');
 assert.equal(interviewSessionToken('','',denied,'production'),'');
});
