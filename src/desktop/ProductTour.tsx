import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { RemotePage } from '../App'

const destinations: { page: RemotePage; selector: string }[] = [
  { page: 'Hosting', selector: '.hosting-policy' },
  { page: 'Task Center', selector: '.hosted-timeline' },
  { page: 'Issues', selector: '.issues-layout, .page-intro' },
  { page: 'Research', selector: '.page-intro' }
]

export default function ProductTour({ onNavigate, onClose, onFinish }: { onNavigate: (page: RemotePage) => void; onClose: () => void; onFinish: () => void }) {
  const { t } = useTranslation()
  const [step, setStep] = useState(0)
  const panel = useRef<HTMLElement>(null)
  const navigate = useRef(onNavigate)
  navigate.current = onNavigate
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const exit = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current() }
    document.addEventListener('keydown', exit)
    return () => document.removeEventListener('keydown', exit)
  }, [])
  useEffect(() => {
    navigate.current(destinations[step].page)
    panel.current?.focus()
    let highlighted: HTMLElement | null = null
    const reveal = () => {
      const target = document.querySelector<HTMLElement>(destinations[step].selector)
      if (!target || target === highlighted) return
      highlighted?.classList.remove('nx-guide-target')
      highlighted = target
      target.classList.add('nx-guide-target')
      target.scrollIntoView({ block: 'center', behavior: 'auto' })
    }
    const observer = new MutationObserver(reveal)
    observer.observe(document.body, { childList: true, subtree: true })
    reveal()
    return () => { observer.disconnect(); highlighted?.classList.remove('nx-guide-target') }
  }, [step])
  return <aside ref={panel} tabIndex={-1} className="nx-product-tour nx-panel" aria-label={t('git:guide.entry')} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <header><span><BookOpen size={17} />{t('git:guide.progress', { step: step + 1, total: destinations.length })}</span><button className="nx-icon-button" onClick={onClose} aria-label={t('common:actions.close')}><X size={16} /></button></header>
    <p className="nx-guide-location">{t('git:guide.location')}: {t(`git:guide.tourLocations.${step}`)}</p>
    <h2>{t(`git:guide.tourTitles.${step}`)}</h2><p>{t(`git:guide.tourDetails.${step}`)}</p>
    <footer><button className="nx-secondary" disabled={step === 0} onClick={() => setStep(step - 1)}><ChevronLeft size={15} />{t('git:setup.previous')}</button><button className="nx-primary" onClick={() => step === destinations.length - 1 ? onFinish() : setStep(step + 1)}>{step === destinations.length - 1 ? t('git:guide.finish') : t('git:setup.next')}<ChevronRight size={15} /></button></footer>
  </aside>
}
