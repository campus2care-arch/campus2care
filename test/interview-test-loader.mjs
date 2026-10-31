import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import ts from 'typescript';
export function loadInterviewModule(name,mocks={}){
  const cache=new Map();
  function load(path){
    path=resolve(path);if(cache.has(path))return cache.get(path).exports;
    const loaded={exports:{}};cache.set(path,loaded);
    const native=createRequire(path);
    const require=(specifier)=>{
      if(Object.hasOwn(mocks,specifier))return mocks[specifier];
      if(specifier.startsWith('.')){const target=resolve(dirname(path),specifier+'.ts');if(existsSync(target))return load(target);}
      return native(specifier);
    };
    const source=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
    new Function('require','module','exports',source)(require,loaded,loaded.exports);
    return loaded.exports;
  }
  return load(new URL('../lib/'+name+'.ts',import.meta.url).pathname);
}
