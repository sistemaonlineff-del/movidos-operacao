import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

test('public map exposes only safe columns of enabled active drop-offs without widening table permissions',async()=>{
  const db=new PGlite()
  try{
    await db.exec(`create role anon;create role authenticated;create table drops(id uuid default gen_random_uuid(),name text,address text,address_number text,neighborhood text,municipality text,state text,postal_code text,latitude numeric,longitude numeric,status text,is_active boolean,deactivated_at timestamptz,registration_type text,phone text,alternate_phone text default '11999999999',pix_key text);
      alter table drops enable row level security;
      insert into drops(name,status,is_active,registration_type,latitude,longitude,phone,pix_key) values('Publicado','ATIVO',true,'drop_off',-23.5,-46.3,' (11) 90000-0001 ','privado'),('Inativo','ATIVO',false,'drop_off',-23.5,-46.3,null,null),('Interessado','INTERESSADO',true,'drop_off',-23.5,-46.3,null,null),('Aguardando','ATIVO - AG. LOGIN',true,'drop_off',-23.5,-46.3,null,null),('Last Mile','ATIVO',true,'last_mile',-23.5,-46.3,null,null),('Coordenadas ruins','ATIVO',true,'drop_off',0,0,null,null),('Excluido','ATIVO',true,'drop_off',-23.5,-46.3,null,null);
      update drops set is_active=false,deactivated_at=now() where name='Excluido';`)
    const sql=await readFile('supabase/migrations/20261110100000_public_active_drop_map.sql','utf8')
    await db.exec(sql);await db.exec(sql)
    const phoneSql=await readFile('supabase/migrations/20261110163000_public_drop_contact_phone.sql','utf8')
    await db.exec(phoneSql);await db.exec(phoneSql)
    for(const role of['anon','authenticated']){
      await db.exec(`set role ${role}`)
      await assert.rejects(db.exec('select * from drops'),/permission denied/)
      const rows=(await db.query('select * from public_active_drops()')).rows
      assert.equal(rows.length,1);assert.equal(rows[0].name,'Publicado')
      assert.deepEqual(Object.keys(rows[0]),['id','name','address','address_number','neighborhood','municipality','state','postal_code','latitude','longitude','phone'])
      assert.equal(rows[0].phone,'(11) 90000-0001')
      await db.exec('reset role')
    }
    for(const phone of['   ',null]){
      await db.query("update drops set phone=$1 where name='Publicado'",[phone])
      await db.exec('set role anon')
      assert.equal((await db.query('select * from public_active_drops()')).rows[0].phone,null)
      await db.exec('reset role')
    }
    await db.exec("update drops set is_active=false where name='Publicado';set role anon")
    assert.equal((await db.query('select * from public_active_drops()')).rows.length,0)
  }finally{await db.close()}
})

test('public map loads anonymously, filters city/neighborhood/address and renders on desktop/mobile',async()=>{
  const origin=process.env.MAP_BASE_URL||'http://127.0.0.1:5175',browser=await chromium.launch({channel:'msedge',headless:true})
  try{
    await mkdir('tmp/public-map',{recursive:true})
    for(const width of[360,1440]){
      const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'}),calls=[],errors=[]
      const points=[{id:'one',name:'Drop Vila Maria',address:'Rua Sintetica',address_number:'10',neighborhood:'Vila Maria',municipality:'Sao Paulo',state:'SP',postal_code:'00000-000',latitude:-23.5,longitude:-46.6,phone:'(11) 90000-0001'},{id:'two',name:'Drop Centro',address:'Rua Teste',address_number:'20',neighborhood:'Centro',municipality:'Suzano',state:'SP',postal_code:'00000-001',latitude:-23.54,longitude:-46.32,phone:null}]
      await context.route('**/*',async route=>{
        const url=new URL(route.request().url())
        if(url.hostname.endsWith('.supabase.co')){
          calls.push(url.pathname);assert.equal(url.pathname,'/rest/v1/rpc/public_active_drops')
          return route.fulfill({contentType:'application/json',body:JSON.stringify(points)})
        }
        if(url.hostname.endsWith('.tile.openstreetmap.org'))return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')})
        assert.equal(url.origin,origin);return route.continue()
      })
      const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message))
      await page.goto(`${origin}/mapa-drops`)
      await page.getByText('2 ponto(s) encontrado(s)',{exact:true}).waitFor()
      assert.equal(await page.locator('aside').count(),0)
      assert.equal(await page.locator('.leaflet-overlay-pane path').count(),2)
      assert.equal(await page.locator('.pdm-results article').first().locator('a[href^="tel:"]').count(),1)
      assert.equal(await page.locator('.pdm-results article').first().getByRole('link',{name:'(11) 90000-0001',exact:true}).getAttribute('href'),'tel:11900000001')
      assert.equal(await page.locator('.pdm-results article').last().locator('a[href^="tel:"]').count(),0)
      await page.locator('.leaflet-overlay-pane path').first().click()
      assert.equal(await page.locator('.leaflet-popup-content a[href^="tel:"]').getAttribute('href'),'tel:11900000001')
      assert.equal(await page.locator('.leaflet-popup-content a[href^="tel:"]').innerText(),'(11) 90000-0001')
      await page.locator('.leaflet-popup-close-button').click()
      await page.getByLabel('Cidade',{exact:true}).selectOption('Suzano')
      await page.getByText('1 ponto(s) encontrado(s)',{exact:true}).waitFor()
      assert.equal(await page.getByRole('heading',{name:'Drop Vila Maria',exact:true}).count(),0)
      await page.getByLabel('Bairro',{exact:true}).selectOption('Centro')
      assert.match(await page.getByRole('link',{name:'Como chegar',exact:true}).getAttribute('href'),/travelmode=driving/)
      await page.getByRole('button',{name:'Limpar filtros',exact:true}).click()
      await page.getByRole('searchbox').fill('vila maria')
      await page.getByRole('heading',{name:'Drop Vila Maria',exact:true}).waitFor()
      await page.getByRole('searchbox').fill('inexistente')
      await page.getByText('Nenhum ponto encontrado.',{exact:true}).waitFor()
      await page.getByRole('button',{name:'Limpar filtros',exact:true}).click()
      const geometry=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}))
      assert.ok(geometry.scroll<=geometry.width+1,JSON.stringify(geometry))
      await page.screenshot({path:`tmp/public-map/map-${width}.png`,fullPage:true})
      assert.ok(calls.length>0);assert.deepEqual(errors,[])
      await context.close()
    }
  }finally{await browser.close()}
})