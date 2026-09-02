const marker = /[\u00c2\u00c3\u00e2]/

function repair(value: string) {
  let output = value
  for (let attempt = 0; attempt < 2 && marker.test(output); attempt += 1) {
    try {
      const bytes = Uint8Array.from(output, character => character.charCodeAt(0))
      const candidate = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (candidate === output) break
      output = candidate
    } catch {
      break
    }
  }
  return output
}

function cleanTree(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node: Text | null
  while ((node = walker.nextNode() as Text | null)) {
    const cleaned = repair(node.data)
    if (cleaned !== node.data) node.data = cleaned
  }

  if (root instanceof Element) {
    for (const element of [root, ...root.querySelectorAll('[placeholder], [title], [aria-label]')]) {
      for (const attribute of ['placeholder', 'title', 'aria-label']) {
        const value = element.getAttribute(attribute)
        if (value) element.setAttribute(attribute, repair(value))
      }
    }
  }
}

function start() {
  if (!document.body) return
  cleanTree(document.body)
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData') cleanTree(record.target.parentNode ?? record.target)
      for (const node of record.addedNodes) cleanTree(node)
      if (record.type === 'attributes' && record.target instanceof Element) cleanTree(record.target)
    }
  })
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label'] })
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
else start()
