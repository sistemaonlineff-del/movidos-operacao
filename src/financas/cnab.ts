import { validDate } from './domain';
import type { Bank, Payment } from './domain.ts';

const digits = (value: string) => value.replace(/\D/g, '');
const text = (value: string, size: number) => {
  const clean = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
  if (/[^\x20-\x7e]/.test(clean) || clean.length > size) throw new Error('Campo textual excede o layout CNAB ou contem caracteres invalidos.');
  return clean.padEnd(size, ' ');
};
const numeric = (value: string | number, size: number) => {
  const clean = String(value);
  if (!/^\d+$/.test(clean) || clean.length > size) throw new Error('Campo numerico invalido no CNAB.');
  return clean.padStart(size, '0');
};
const dateField = (date: string) => { if (!validDate(date)) throw new Error('Data de pagamento obrigatoria e valida.'); return date.split('-').reverse().join(''); };
type Field = [number, number, string];
const record = (fields: Field[]) => {
  const result = Array<string>(240).fill(' ');
  const occupied = new Set<number>();
  for (const [start, size, value] of fields) {
    if (start < 1 || start + size - 1 > 240 || value.length > size) throw new Error('Campo fora do layout CNAB.');
    for (let offset = 0; offset < size; offset++) {
      const position = start - 1 + offset;
      if (occupied.has(position)) throw new Error('Campos sobrepostos no CNAB.');
      occupied.add(position); result[position] = value[offset] ?? ' ';
    }
  }
  return result.join('');
};

export function pixKey(value: string) {
  const key = value.trim(); const number = digits(key);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) return { type: '02', key };
  if (/^\d{3}\.\d{3}\.\d{3}-\d{2}$|^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$|^\d{11}$|^\d{14}$/.test(key)) return { type: '03', key: number };
  if (/^[+()\d\s-]+$/.test(key) && [10,11,12,13].includes(number.length)) {
    const phone = number.length <= 11 ? `55${number}` : number;
    if (!phone.startsWith('55')) throw new Error('Telefone Pix deve conter DDI 55.');
    return { type: '01', key: `+${phone}` };
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) return { type: '04', key };
  throw new Error('Chave Pix invalida. Para telefone use +55 ou formatacao com DDD.');
}

export function createCnab(payments: Payment[], bank: Bank, generatedAt = new Date()): string {
  if (!payments.length || payments.length > 49999) throw new Error('Selecione de 1 a 49.999 pagamentos.');
  if (!Number.isInteger(bank.sequence) || bank.sequence < 1 || bank.sequence > 999999) throw new Error('Sequencial de remessa invalido.');
  if (digits(bank.document).length !== 14 || digits(bank.postalCode).length !== 8 || !/^[A-Z]{2}$/.test(bank.state) || !bank.name || !bank.street || !bank.city) throw new Error('Complete os dados da empresa pagadora.');
  const company: Field[] = [[18,1,'2'],[19,14,digits(bank.document)],[53,5,numeric(bank.branch,5)],[58,1,numeric(bank.branchDigit,1)],[59,12,numeric(bank.account,12)],[71,1,numeric(bank.accountDigit,1)],[73,30,text(bank.name,30)]];
  const date = `${generatedAt.getFullYear()}-${String(generatedAt.getMonth()+1).padStart(2,'0')}-${String(generatedAt.getDate()).padStart(2,'0')}`;
  const time = [generatedAt.getHours(), generatedAt.getMinutes(), generatedAt.getSeconds()].map(value=>String(value).padStart(2,'0')).join('');
  const lines = [record([[1,3,'077'],[4,4,'0000'],[8,1,'0'],...company,[103,30,text('BANCO INTER',30)],[143,1,'1'],[144,8,dateField(date)],[152,6,time],[158,6,numeric(bank.sequence,6)],[164,3,'107'],[167,5,'01600']]),record([[1,3,'077'],[4,4,'0001'],[8,1,'1'],[9,1,'C'],[10,2,'20'],[12,2,'45'],[14,3,'046'],...company,[143,30,text(bank.street,30)],[173,5,numeric(bank.number,5)],[178,15,text(bank.complement,15)],[193,20,text(bank.city,20)],[213,8,digits(bank.postalCode)],[221,2,bank.state]])];
  let sequence = 1; let total = 0;
  for (const payment of payments) {
    if (!Number.isSafeInteger(payment.amount) || payment.amount <= 0) throw new Error('Pagamento deve ser positivo em centavos.');
    const pix = pixKey(payment.pix); const document = digits(payment.document);
    if (![11,14].includes(document.length)) throw new Error('CPF/CNPJ do favorecido obrigatorio para homologacao.');
    const holder = payment.holder || payment.responsible || payment.name;
    lines.push(record([[1,3,'077'],[4,4,'0001'],[8,1,'3'],[9,5,numeric(sequence++,5)],[14,1,'A'],[15,1,'0'],[16,2,'00'],[18,3,'000'],[21,3,'000'],[24,5,'00000'],[29,1,'0'],[30,12,'000000000000'],[42,1,'0'],[44,30,text(holder,30)],[94,8,dateField(payment.date)],[102,3,'BRL'],[105,15,'000000000000000'],[120,15,numeric(payment.amount,15)]]));
    lines.push(record([[1,3,'077'],[4,4,'0001'],[8,1,'3'],[9,5,numeric(sequence++,5)],[14,1,'B'],[15,3,pix.type],[18,1,document.length===11?'1':'2'],[19,14,numeric(document,14)],[128,99,text(pix.key,99)],[233,8,'00000000']]));
    total += payment.amount;
    if (!Number.isSafeInteger(total)) throw new Error('Total excede precisao permitida.');
  }
  lines.push(record([[1,3,'077'],[4,4,'0001'],[8,1,'5'],[18,6,numeric(2+payments.length*2,6)],[24,6,numeric(payments.length,6)],[30,18,numeric(total,18)]]));
  lines.push(record([[1,3,'077'],[4,4,'9999'],[8,1,'9'],[18,6,'000001'],[24,6,numeric(lines.length+1,6)]]));
  return lines.join('\r\n')+'\r\n';
}