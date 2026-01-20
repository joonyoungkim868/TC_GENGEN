import * as XLSX from 'xlsx';
import { TestCase } from '../types';

export const exportToExcel = (testCases: TestCase[], fileName: string) => {
  // Map internal data structure to the 8-column format
  const data = testCases.map((tc) => ({
    'No.': tc.no,
    '제목': tc.title,
    '1Depth': tc.depth1,
    '2Depth': tc.depth2,
    '3Depth': tc.depth3,
    '사전조건': tc.precondition,
    '절차': tc.steps,
    '예상결과': tc.expectedResult,
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  
  // Set column widths (optional but nice)
  const colWidths = [
    { wch: 5 },  // No
    { wch: 30 }, // 제목
    { wch: 15 }, // 1Depth
    { wch: 15 }, // 2Depth
    { wch: 15 }, // 3Depth
    { wch: 30 }, // 사전조건
    { wch: 40 }, // 절차
    { wch: 40 }, // 예상결과
  ];
  worksheet['!cols'] = colWidths;

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'TestCases');

  XLSX.writeFile(workbook, `${fileName}.xlsx`);
};
