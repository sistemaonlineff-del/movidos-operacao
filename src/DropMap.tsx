// @ts-nocheck
import {useEffect,useMemo,useRef,useState} from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Drop } from './lib/types'
import { DROP_STATUSES } from './dropOptions'
const statusTone=(status:string)=>{if(status.startsWith('ATIVO'))return 'active';if(status.includes('PROBLEMA')||status.includes('EXCLU'))return 'problem';if(status.includes('CONGELADO'))return 'frozen';return 'progress'}
const statusColor:Record<string,string>={active:'#008b89',progress:'#237be7',frozen:'#7556c7',problem:'#d94b44'}
const mapLocation=(drop:Drop)=>drop.latitude!==null&&drop.longitude!==null&&Number(drop.latitude)>=-35&&Number(drop.latitude)<=6&&Number(drop.longitude)>=-75&&Number(drop.longitude)<=-32
const searchText=(value:unknown)=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
export default function DropMap({drops}:{drops:Drop[]}) {
	const holder=useRef<HTMLDivElement>(null)
	const [city,setCity]=useState(''), [status,setStatus]=useState(''), [activity,setActivity]=useState('enabled')
	const points=useMemo(()=>drops.filter(mapLocation),[drops])
	const cities=useMemo(()=>[...new Set(points.map(drop=>String(drop.municipality??'')).filter(Boolean))].sort((first,second)=>first.localeCompare(second,'pt-BR')),[points])
	const filtered=useMemo(()=>points.filter(drop=>(!city||searchText(drop.municipality).includes(searchText(city)))&&(!status||drop.status===status)&&(!activity||(activity==='enabled'?drop.is_active!==false:drop.is_active===false))),[points,city,status,activity])
	useEffect(()=>{
		if(!holder.current)return
		const map=L.map(holder.current,{scrollWheelZoom:true}).setView([-14.235,-51.925],4)
		L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap'}).addTo(map)
		const bounds:L.LatLngExpression[]=[]
		filtered.forEach(drop=>{
			const point:[number,number]=[Number(drop.latitude),Number(drop.longitude)]; bounds.push(point)
			const color=drop.is_active===false?'#777777':statusColor[statusTone(drop.status)]
			const popup=document.createElement('div')
			for(const value of [drop.name,[drop.municipality,drop.state].filter(Boolean).join(' '),drop.status]){const line=document.createElement('div');line.textContent=value;popup.append(line)}
			L.circleMarker(point,{radius:7,color,fillColor:color,fillOpacity:.88,weight:2}).addTo(map).bindPopup(popup)
		})
		if(bounds.length)map.fitBounds(bounds,{padding:[32,32],maxZoom:12})
		return()=>{map.remove()}
	},[filtered])
	return <section className="card map-card"><div className="map-heading"><div><p className="eyebrow">MAPA OPERACIONAL</p><h2>Pontos de coleta</h2></div><span>{filtered.length} localizacoes exibidas</span></div>
		<div className="map-controls"><label>Filtrar por cidade<input list="cities-map" value={city} onChange={event=>setCity(event.target.value)}/></label><label>Status no mapa<select aria-label="Status no mapa" value={status} onChange={event=>setStatus(event.target.value)}><option value="">Todos os status</option>{DROP_STATUSES.map(value=><option key={value}>{value}</option>)}</select></label><label>Situação cadastral<select aria-label="Situação cadastral" value={activity} onChange={event=>setActivity(event.target.value)}><option value="enabled">Não desativados</option><option value="disabled">Desativados</option><option value="">Todos</option></select></label><button type="button" className="secondary" onClick={()=>{setCity('');setStatus('');setActivity('')}}>Limpar mapa</button><datalist id="cities-map">{cities.map(item=><option key={item} value={item}/>)}</datalist></div>
		<div className="map-legend"><span><i className="status-dot status-active"/>Ativo</span><span><i className="status-dot status-progress"/>Em andamento</span><span><i className="status-dot status-frozen"/>Congelado</span><span><i className="status-dot status-problem"/>Problema / excluido</span></div><div className="drops-map" ref={holder}/></section>
}
