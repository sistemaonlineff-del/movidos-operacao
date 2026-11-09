import { useLayoutEffect } from 'react'
import { DROP_REGISTRATION_API, MAX_PHOTO_BYTES, MAX_TOTAL_PHOTO_BYTES, type RegistrationPhoto } from './dropRegistrationShared'

export function useDropRegistrationViewport() {
  useLayoutEffect(()=>{
    const existing=document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    const viewport=existing??document.createElement('meta'),previous=viewport.getAttribute('content')??'width=980'
    viewport.name='viewport';viewport.setAttribute('content','width=device-width, initial-scale=1')
    if(!existing)document.head.append(viewport)
    return ()=>{viewport.setAttribute('content',previous)}
  },[])
}

export async function dropRegistrationRequest(input?: Record<string, unknown>, token?: string, offset=0) {
  const response=await fetch(`${DROP_REGISTRATION_API}${input?'':`?offset=${offset}`}`,{
    method:input?'POST':'GET',cache:'no-store',credentials:'omit',
    headers:{...(input?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},
    ...(input?{body:JSON.stringify(input)}:{})
  }).catch(()=>{throw new Error('Conexao interrompida. Guarde o protocolo e tente novamente com os mesmos dados e fotos.')})
  const data=await response.json().catch(()=>({error:'Resposta indisponivel. Guarde o protocolo e tente novamente.'}))
  if (!response.ok) throw new Error(data.error||'Nao foi possivel concluir a operacao.')
  return data
}

export async function prepareRegistrationPhoto(file: File): Promise<RegistrationPhoto> {
  if (!['image/jpeg','image/png','image/webp'].includes(file.type) || !file.size || file.size>MAX_PHOTO_BYTES) throw new Error('Envie JPEG, PNG ou WebP de ate 2 MB por arquivo.')
  const image=await createImageBitmap(file).catch(()=>{throw new Error('Nao foi possivel abrir esta imagem.')})
  try {
    if (image.width*image.height>16000000 || image.width>8192 || image.height>8192) throw new Error('A foto deve ter ate 16 megapixels.')
    const scale=Math.min(1,1600/Math.max(image.width,image.height))
    const canvas=document.createElement('canvas')
    canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale))
    const context=canvas.getContext('2d')
    if (!context) throw new Error('Editor de imagem indisponivel neste navegador.')
    context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height)
    const encoded=canvas.toDataURL('image/jpeg',0.85)
    if (!encoded.startsWith('data:image/jpeg;base64,')) throw new Error('Nao foi possivel preparar a foto.')
    return {content:encoded.split(',')[1],fileName:file.name.replace(/\.[^.]*$/,'')+'.jpg',caption:''}
  } finally {image.close()}
}

export const photoBytes = (photos: RegistrationPhoto[]) => photos.reduce((sum,photo)=>sum+Math.floor(photo.content.length*3/4)-(photo.content.endsWith('==')?2:photo.content.endsWith('=')?1:0),0)
export function checkPhotoTotal(photos: RegistrationPhoto[]) {
  if (photoBytes(photos)>MAX_TOTAL_PHOTO_BYTES) throw new Error('As fotos devem somar no maximo 2 MB. Remova uma foto ou use arquivos menores.')
}