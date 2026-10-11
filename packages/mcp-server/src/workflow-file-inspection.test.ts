import { afterEach,describe,expect,it } from 'vitest';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from 'exceljs';
import { generateWorkflowReportMapping,inspectWorkflowFile,inspectWorkflowProjectVersion } from './workflow-file-inspection.js';

const roots:string[]=[];
async function makeRoot():Promise<string> {
  const root=await mkdtemp(path.join(os.tmpdir(),'lnwjud-workflow-choices-'));
  roots.push(root);return root;
}
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))});

describe('workflow suggestions from workspace files',()=>{
  it('lists real CSV and XLSX columns and detects only an actual project version',async()=>{
    const root=await makeRoot();
    await writeFile(path.join(root,'package.json'),JSON.stringify({version:'5.8.3'}));
    await writeFile(path.join(root,'items.csv'),'รหัส,ชื่อ,ราคา\n001,ไทย,10');
    expect(await inspectWorkflowProjectVersion(root)).toBe('5.8.3');
    expect(await inspectWorkflowFile(root,'items.csv')).toMatchObject({
      fileType:'csv',sheets:[{name:'CSV',columns:['รหัส','ชื่อ','ราคา']}],
    });
    const book=new ExcelJS.Workbook();const first=book.addWorksheet('รายการ');
    first.addRow(['id','label']);first.addRow(['001','A']);
    book.addWorksheet('Summary').getCell('B1').value='Count';
    await book.xlsx.writeFile(path.join(root,'data.xlsx'));
    expect(await inspectWorkflowFile(root,'data.xlsx')).toMatchObject({
      fileType:'xlsx',sheets:[{name:'รายการ',columns:['id','label']},{name:'Summary',columns:['Count']}],
    });
  });
  it('rejects out-of-workspace paths and generates a new mapping without changing the template',async()=>{
    const root=await makeRoot();const external=await makeRoot();
    await writeFile(path.join(external,'external.csv'),'id\n1');
    await expect(inspectWorkflowFile(root,path.join(external,'external.csv'))).rejects.toThrow();
    const book=new ExcelJS.Workbook();const sheet=book.addWorksheet('Report');
    sheet.getCell('A1').value='Existing heading';
    const templatePath=path.join(root,'template.xlsx');await book.xlsx.writeFile(templatePath);
    const before=await readFile(templatePath);
    const mappingPath=await generateWorkflowReportMapping(root,templatePath,'Report');
    const mapping=JSON.parse(await readFile(mappingPath,'utf8'));
    expect(mapping).toEqual({schemaVersion:1,cells:[],tables:[{
      sheet:'Report',startCell:'A3',columns:['sheet','address','kind','message'],
    }]});
    expect(await readFile(templatePath)).toEqual(before);
    await expect(generateWorkflowReportMapping(root,templatePath,'Missing')).rejects.toThrow('Report worksheet not found');
  });
});
