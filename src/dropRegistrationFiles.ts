import { createHash } from 'node:crypto'
import { MIN_PHOTOS, MAX_PHOTOS, MAX_PHOTO_BYTES, MAX_TOTAL_PHOTO_BYTES } from './dropRegistrationShared.js'

export const registrationHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

export function registrationImage(content: Buffer) {
  let width = 0, height = 0, type = '', extension = ''
  if (content.length > MAX_PHOTO_BYTES || content.length < 20) throw new Error('Foto vazia, invalida ou maior que 2 MB.')
  if (content.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    let offset = 8, ended = false, imageData = false
    while (offset + 12 <= content.length) {
      const length = content.readUInt32BE(offset), chunk = content.toString('ascii',offset+4,offset+8)
      if (offset+12+length > content.length) throw new Error('PNG truncado.')
      if (offset === 8) {
        if (chunk !== 'IHDR' || length !== 13) throw new Error('PNG sem cabecalho valido.')
        width = content.readUInt32BE(offset+8); height = content.readUInt32BE(offset+12)
      }
      if (chunk === 'acTL') throw new Error('PNG animado nao permitido.')
      if (chunk === 'IDAT' && length>0) imageData=true
      if (chunk === 'IEND') { ended = length === 0 && offset+12 === content.length; break }
      offset += 12+length
    }
    if (!ended || !imageData) throw new Error('PNG incompleto.')
    type='image/png'; extension='png'
  } else if (content[0] === 255 && content[1] === 216 && content[content.length-2] === 255 && content[content.length-1] === 217) {
    let offset = 2, scan = false
    while (offset+4 <= content.length) {
      if (content[offset] !== 255) throw new Error('JPEG invalido.')
      while (content[offset] === 255) offset++
      const marker=content[offset++]
      if (marker === 218) {
        if (offset+2>content.length) throw new Error('JPEG truncado.')
        const length=content.readUInt16BE(offset)
        scan=length>=6 && offset+length<content.length-2
        break
      }
      if (marker === 217) break
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      if (offset+2>content.length) throw new Error('JPEG truncado.')
      const length=content.readUInt16BE(offset)
      if (length<2 || offset+length>content.length) throw new Error('JPEG truncado.')
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if (length<8) throw new Error('JPEG sem dimensoes.')
        height=content.readUInt16BE(offset+3); width=content.readUInt16BE(offset+5)
      }
      offset+=length
    }
    if (!scan) throw new Error('JPEG sem dados de imagem.')
    type='image/jpeg'; extension='jpg'
  } else if (content.toString('ascii',0,4)==='RIFF' && content.toString('ascii',8,12)==='WEBP' && content.readUInt32LE(4)+8===content.length) {
    let offset=12,imageData=false
    while(offset+8<=content.length) {
      const chunk=content.toString('ascii',offset,offset+4),length=content.readUInt32LE(offset+4),start=offset+8,end=start+length
      if(end>content.length)throw new Error('WebP truncado.')
      if(chunk==='ANIM'||chunk==='ANMF')throw new Error('WebP animado nao permitido.')
      if(chunk==='VP8X'){
        if(offset!==12||length!==10||(content[start]&2))throw new Error('Cabecalho WebP invalido ou animado.')
        width=1+content.readUIntLE(start+4,3);height=1+content.readUIntLE(start+7,3)
      }
      if(chunk==='VP8L'||chunk==='VP8 '){
        if(imageData)throw new Error('WebP com imagens repetidas.')
        let frameWidth=0,frameHeight=0
        if(chunk==='VP8L'&&length>=5&&content[start]===47){const bits=content.readUInt32LE(start+1);frameWidth=(bits&0x3fff)+1;frameHeight=((bits>>>14)&0x3fff)+1}
        if(chunk==='VP8 '&&length>=10&&(content[start]&1)===0&&content.subarray(start+3,start+6).equals(Buffer.from([157,1,42]))){frameWidth=content.readUInt16LE(start+6)&0x3fff;frameHeight=content.readUInt16LE(start+8)&0x3fff}
        if(!frameWidth||!frameHeight||(width&&width!==frameWidth)||(height&&height!==frameHeight))throw new Error('Dimensoes WebP invalidas.')
        width=frameWidth;height=frameHeight;imageData=true
      }
      offset=end+(length%2)
    }
    if(!imageData||offset!==content.length)throw new Error('WebP sem imagem completa.')
    type='image/webp';extension='webp'
  }
  if (!type || width<1 || height<1 || width>8192 || height>8192 || width*height>16000000) throw new Error('Envie JPEG, PNG ou WebP valido de ate 16 megapixels; SVG nao e aceito.')
  return {type,extension,width,height}
}

export function registrationFiles(input: unknown) {
  if (!Array.isArray(input) || input.length<MIN_PHOTOS || input.length>MAX_PHOTOS) throw new Error('Envie de tres a cinco fotos.')
  let total=0
  const hashes=new Set<string>()
  return input.map((photo: unknown) => {
    if (!photo || typeof photo!=='object') throw new Error('Foto invalida.')
    const source=photo as Record<string,unknown>
    if (typeof source.content!=='string' || source.content.length>Math.ceil(MAX_PHOTO_BYTES/3)*4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(source.content)) throw new Error('Conteudo da foto invalido.')
    const content=Buffer.from(source.content,'base64')
    if (content.toString('base64')!==source.content) throw new Error('Codificacao da foto invalida.')
    total+=content.length
    if (total>MAX_TOTAL_PHOTO_BYTES) throw new Error('As fotos devem somar no maximo 2 MB.')
    const image=registrationImage(content), digest=registrationHash(content)
    if (hashes.has(digest)) throw new Error('Remova a foto repetida.')
    hashes.add(digest)
    if (source.caption != null && typeof source.caption !== 'string') throw new Error('Legenda invalida.')
    if (source.fileName != null && typeof source.fileName !== 'string') throw new Error('Nome da foto invalido.')
    const caption=String(source.caption??'').trim()
    if (caption.length>200 || /[\x00-\x1f]/.test(caption)) throw new Error('Legenda invalida ou muito longa.')
    const name=String(source.fileName??`foto.${image.extension}`).replace(/[\x00-\x1f<>:"/\\|?*]/g,'_').slice(0,150) || `foto.${image.extension}`
    return {...image,content,digest,name,caption}
  })
}