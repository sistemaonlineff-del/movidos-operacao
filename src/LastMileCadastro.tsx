import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import DropDocuments from "./DropDocuments";
import { supabase } from "./lib/supabase";
import { PARTNERS } from "./dropOptions";

const days = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
const initial = { name:"", cpf:"", address:"", neighborhood:"", municipality:"", state:"SP", postal_code:"", phone:"", alternate_phone:"", email:"", weekly_package_value:"", sunday_holiday_package_value:"", pix_key:"", pix_holder_name:"", pix_key_type:"", vehicle_plate:"", delivery_cities:"", work_days:[] as string[], partner:"", cnpj:"", state_registration:"", legal_name:"", trade_name:"", company_address:"", company_address_number:"", company_neighborhood:"", company_municipality:"", company_state:"SP", company_postal_code:"" };

export default function LastMileCadastro() {
  const nav = useNavigate(); const [values,setValues] = useState(initial); const [id,setId] = useState<string | null>(null); const [saving,setSaving]=useState(false); const [message,setMessage]=useState("");
  const put=(field:string,value:any)=>setValues(current=>({...current,[field]:value}));
  const submit=async(event:FormEvent)=>{event.preventDefault(); if(!supabase)return; if(!values.name.trim()){setMessage("Informe o nome.");return} setSaving(true);setMessage("");
    const money=(value:string)=>Number(value.replace(/[^0-9,.-]/g,"").replace(",","."))||0;
    const payload:any={...values, registration_type:"last_mile", status:"INTERESSADO", weekly_package_value:money(values.weekly_package_value), sunday_holiday_package_value:money(values.sunday_holiday_package_value), work_days:values.work_days.join(", ")};
    const {data,error}=await supabase.from("drops").insert(payload).select().single(); setSaving(false);
    if(error){setMessage(error.message);return} setId(data.id);setMessage("Cadastro Last Mile salvo. Agora você pode anexar arquivos e gerar os documentos.");
  };
  const input=(label:string,field:keyof typeof values,type="text")=><label>{label}<input type={type} value={String(values[field] ?? "")} onChange={e=>put(field,e.target.value)} /></label>;
  return <section className="cadastro-form"><form onSubmit={submit}><section className="form-section"><h3>Novo cadastro Last Mile</h3><div className="form-grid">
    {input("Nome","name")}{input("CPF","cpf")}{input("Telefone 1","phone")}{input("Telefone 2","alternate_phone")}{input("E-mail","email","email")}
    <label>Parceiro logístico<select value={values.partner} onChange={e=>put("partner",e.target.value)}><option value="">Selecionar</option>{PARTNERS.map(partner=><option key={partner}>{partner}</option>)}</select></label>
    {input("Valor por pacote semanal (R$)","weekly_package_value","number")}{input("Valor por pacote domingo e feriado (R$)","sunday_holiday_package_value","number")}
    {input("Chave PIX","pix_key")} {input("Nome da chave PIX","pix_holder_name")}<label>Tipo de veículo<select value={values.pix_key_type} onChange={e=>put("pix_key_type",e.target.value)}><option value="">Selecionar</option><option>CPF</option><option>CNPJ</option><option>E-mail</option><option>Telefone</option><option>Chave aleatória</option></select></label>{input("Placa do veículo","vehicle_plate")}
  </div></section><section className="form-section"><h3>Endereço e entregas</h3><div className="form-grid">{input("Endereço","address")}{input("Bairro","neighborhood")}{input("Cidade","municipality")} {input("Estado","state")} {input("CEP","postal_code")}<label className="full">Cidades que aceita fazer entregas<textarea value={values.delivery_cities} onChange={e=>put("delivery_cities",e.target.value)} /></label><fieldset className="full"><legend>Dias que vai trabalhar</legend>{days.map(day=><label key={day} className="check"><input type="checkbox" checked={values.work_days.includes(day)} onChange={e=>put("work_days",e.target.checked?[...values.work_days,day]:values.work_days.filter(value=>value!==day))}/>{day}</label>)}</fieldset></div></section><section className="form-section"><h3>Dados da empresa</h3><div className="form-grid">{input("CNPJ","cnpj")}{input("IE","state_registration")}{input("Razão social","legal_name")}{input("Nome fantasia","trade_name")}{input("Rua","company_address")}{input("Número","company_address_number")}{input("Bairro","company_neighborhood")}{input("Cidade","company_municipality")}{input("UF","company_state")}{input("CEP","company_postal_code")}</div></section>
  {message&&<p className="form-message">{message}</p>}<div className="modal-actions"><button type="button" onClick={()=>nav("/cadastros/last-mile")}>Cancelar</button><button className="primary compact" disabled={saving}>{saving?"Salvando…":"Salvar cadastro Last Mile"}</button></div></form>{id&&<><DropDocuments dropId={id}/><section className="card"><p>Os botões de contrato e distrato ficam disponíveis no cadastro após o salvamento.</p></section></>}</section>
}
