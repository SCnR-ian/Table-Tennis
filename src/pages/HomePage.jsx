import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Camera, Upload, X, Loader2, Plus, Trash2 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useClub } from "@/context/ClubContext";
import { useEditMode } from "@/context/EditModeContext";
import { homepageAPI, pagesAPI } from "@/api/api";
import EditableText from "@/components/cms/EditableText";

const PLACEHOLDER_BANNER = '/placeholder-banner.svg'

// slots: array of null | { id, url }  — or legacy array of strings
function BannerSlideshow({ className = "", slots }) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const srcs = (() => {
    if (slots === null) return [] // still loading — show nothing yet
    const filled = slots.filter(Boolean).map(s => typeof s === 'string' ? s : s.url)
    return filled
  })()

  const isEmpty = srcs.length === 0
  const [current, setCurrent] = useState(0)
  useEffect(() => { setCurrent(0) }, [srcs.length])
  useEffect(() => {
    if (srcs.length <= 1) return
    const t = setInterval(() => setCurrent(i => (i + 1) % srcs.length), 4000)
    return () => clearInterval(t)
  }, [srcs.length])

  if (isEmpty) {
    return (
      <div className={`relative overflow-hidden bg-white ${className}`}>
        <img src={PLACEHOLDER_BANNER} alt="Placeholder" className="absolute inset-0 w-full h-full object-contain" />
        {isAdmin && (
          <div className="absolute bottom-4 left-4 text-xs text-gray-400 bg-white/80 px-3 py-1.5 rounded-full">
            Click Edit Page to change image
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`relative overflow-hidden ${className}`}>
      {srcs.map((src, i) => (
        <img
          key={src}
          src={src}
          alt=""
          className="absolute inset-0 w-full h-full object-cover transition-opacity duration-1000"
          style={{ opacity: i === current ? 1 : 0 }}
        />
      ))}
    </div>
  )
}

// Modal showing 6 slots — click to upload/replace, hover delete button to remove
// slots: array of null | { id, url }
function BannerSlotModal({ title, slots, onUploadSlot, onDeleteSlot, onClose }) {
  const inputRefs = useRef([])
  const [busy, setBusy] = useState(null) // slot index being uploaded or deleted

  const handleFile = async (i, e) => {
    const file = e.target.files[0]
    if (!file) return
    e.target.value = ''
    setBusy(i)
    await onUploadSlot(i, file)
    setBusy(null)
  }

  const handleDelete = async (e, i) => {
    e.stopPropagation()
    setBusy(i)
    await onDeleteSlot(i)
    setBusy(null)
  }

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl p-6 w-[520px] max-w-[90vw]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-1">
          <h3 className="font-bold text-lg">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 p-0.5">
            <X size={18} />
          </button>
        </div>
        <p className="text-gray-500 text-sm mb-5">
          Up to 6 images. Click a slot to upload or replace.
        </p>
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => {
            const slot = slots[i]
            return (
              <div key={i} className="relative group/slot">
                <button
                  onClick={() => inputRefs.current[i]?.click()}
                  className={`w-full aspect-[4/3] rounded-xl overflow-hidden border-2 flex flex-col items-center justify-center transition-opacity hover:opacity-80
                    ${slot ? 'border-transparent' : 'border-dashed border-gray-300 bg-gray-50'}`}
                >
                  {slot ? (
                    <img src={slot.url} alt={`Slot ${i + 1}`} className="w-full h-full object-cover" />
                  ) : (
                    <>
                      <Upload size={22} className="text-gray-300 mb-1.5" />
                      <span className="text-gray-400 text-xs">{i === 0 ? 'Default' : `Slot ${i + 1}`}</span>
                    </>
                  )}
                  {busy === i && (
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center rounded-xl">
                      <Loader2 size={20} className="text-white animate-spin" />
                    </div>
                  )}
                </button>

                {/* Slot number badge */}
                {slot && (
                  <span className="absolute bottom-1.5 left-1.5 bg-black/50 text-white text-[10px] font-medium px-1.5 py-0.5 rounded pointer-events-none">
                    {i + 1}
                  </span>
                )}

                {/* Delete button — appears on hover when slot is filled */}
                {slot && busy !== i && (
                  <button
                    onClick={e => handleDelete(e, i)}
                    className="absolute top-1.5 right-1.5 z-10 bg-black/60 hover:bg-red-600 text-white rounded-full p-1 opacity-0 group-hover/slot:opacity-100 transition-opacity"
                    title="Delete image"
                  >
                    <X size={12} />
                  </button>
                )}

                <input
                  ref={el => { inputRefs.current[i] = el }}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={e => handleFile(i, e)}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// Wraps a banner section — shows "Replace Image" button in edit mode, opens slot modal on click
function EditableBanner({ className, title, slots, onUploadSlot, onDeleteSlot, children }) {
  const { isEditing } = useEditMode()
  const [modalOpen, setModalOpen] = useState(false)

  return (
    <div className={`relative group ${className}`}>
      {children}
      {isEditing && (
        <>
          <button
            onClick={() => setModalOpen(true)}
            className="absolute bottom-4 left-4 z-20 flex items-center gap-1.5 bg-black/60 hover:bg-black/80 text-white text-xs font-medium px-3 py-1.5 rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-sm"
          >
            <Camera size={13} />
            Replace Image
          </button>
          {modalOpen && (
            <BannerSlotModal
              title={title}
              slots={slots}
              onUploadSlot={onUploadSlot}
              onDeleteSlot={onDeleteSlot}
              onClose={() => setModalOpen(false)}
            />
          )}
        </>
      )}
    </div>
  )
}

const DEFAULT_HERO = {
  headline:    '',
  subheadline: '',
}
const DEFAULT_INTRO = {
  headline: '',
  body1: '',
  body2: '',
}
const DEFAULT_CONTACT = {
  phone:    '',
  email:    '',
  address:  '',
  wechat:   '',
  gettingHere: '',
  schedule: [],
}

const CARD_FALLBACKS = {
  private: "/images/training/private.png",
  group: "/images/training/group.png",
  school: "/images/training/school.png",
  holiday: "/images/training/holiday.png",
};
const DEFAULT_CARDS = [
  { id: "private", title: "One-on-One", hasImage: false },
  { id: "group", title: "Group Session", hasImage: false },
  { id: "school", title: "School Coaching", hasImage: false },
  { id: "holiday", title: "School Holiday", hasImage: false },
];

export default function HomePage() {
  const { isAuthenticated } = useAuth();
  const { club } = useClub() ?? {}
  const { isEditing } = useEditMode()
  const [stats, setStats] = useState({ membersDisplay: '—', coachingSessions: '—', socialSessions: '—' });
  const [cards, setCards] = useState(DEFAULT_CARDS);
  const [hero, setHero] = useState(DEFAULT_HERO)
  const [intro, setIntro] = useState(DEFAULT_INTRO)
  const [contact, setContact] = useState(DEFAULT_CONTACT)
  const [programs, setPrograms] = useState({ headline: 'Explore Our Training Programs', cardTitles: {} })
  const [cta, setCta] = useState({ headline: 'Ready to Play?', body: '' })
  const [cardTimestamps, setCardTimestamps] = useState({})
  const cardInputRefs = useRef({})
  // Each banner: fixed array of 6 slots — null | { id, url }
  // Initialise from sessionStorage so the default image shows instantly on reload.
  // Key is namespaced by club subdomain so different clubs don't share the cache.
  const clubKey = 'epping'
  const initSlots = (prefix) => {
    const cached = sessionStorage.getItem(`${clubKey}_${prefix}0`)
    if (!cached) return null
    const slots = Array(6).fill(null)
    slots[0] = { id: `${prefix}0`, url: cached }
    return slots
  }
  const [bannerSlots,  setBannerSlots]  = useState(() => initSlots('home_banner_'))
  const [bannerSlots2, setBannerSlots2] = useState(() => initSlots('home_banner2_'))
  const [bannerSlots3, setBannerSlots3] = useState(() => initSlots('home_banner3_'))

  // Seed defaults from ClubContext once it loads
  useEffect(() => {
    if (!club) return
    setHero(h => ({
      ...h,
      headline:    h.headline    || club.name,
      subheadline: h.subheadline || '',
    }))
    setContact(ct => ({
      ...ct,
      phone:   ct.phone   || club.settings?.contactPhone || '',
      email:   ct.email   || club.settings?.contactEmail || '',
      address: ct.address || club.settings?.address      || '',
      wechat:  ct.wechat  ?? club.settings?.wechat       ?? '',
    }))
  }, [club])

  // Loads slots for a banner prefix into a fixed 6-element array
  const loadBannerSlots = (prefix, setSlots) => {
    pagesAPI.getImageIds(prefix).then(r => {
      const slots = Array(6).fill(null)
      ;(r.data.ids ?? []).forEach(id => {
        const i = parseInt(id.slice(prefix.length), 10)
        if (!isNaN(i) && i >= 0 && i < 6) {
          const base = pagesAPI.getImageUrl(id)
          const sep = base.includes('?') ? '&' : '?'
          slots[i] = { id, url: `${base}${sep}t=${Date.now()}` }
        }
      })
      // Cache slot-0 URL (namespaced by club) so next page load shows it instantly
      if (slots[0]?.url) sessionStorage.setItem(`${clubKey}_${prefix}0`, slots[0].url)
      else sessionStorage.removeItem(`${clubKey}_${prefix}0`)
      setSlots(slots)
    }).catch(() => {})
  }

  const loadBanners = () => {
    loadBannerSlots('home_banner_',  setBannerSlots)
    loadBannerSlots('home_banner2_', setBannerSlots2)
    loadBannerSlots('home_banner3_', setBannerSlots3)
  }

  useEffect(() => {
    homepageAPI.getStats().then(r => setStats(r.data)).catch(() => {})
    homepageAPI.getCards().then(r => setCards(r.data.cards)).catch(() => {})
    pagesAPI.getContent().then(r => {
      const c = r.data.content
      if (c.home_hero)     setHero(h => ({ ...h, ...c.home_hero }))
      if (c.home_intro)    setIntro(h => ({ ...h, ...c.home_intro }))
      if (c.home_contact)  setContact(ct => ({ ...ct, ...c.home_contact }))
      if (c.home_programs) setPrograms(p => ({ ...p, ...c.home_programs }))
      if (c.home_cta)      setCta(ct => ({ ...ct, ...c.home_cta }))
    }).catch(() => {})
    loadBanners()
  }, []);

  // ── Save helpers ──────────────────────────────────────────────────────────
  const saveHero = (field, value) => {
    const updated = { ...hero, [field]: value }
    setHero(updated)
    pagesAPI.updateContent('home_hero', updated).catch(() => {})
  }

  const saveIntro = (field, value) => {
    const updated = { ...intro, [field]: value }
    setIntro(updated)
    pagesAPI.updateContent('home_intro', updated).catch(() => {})
  }

  const saveContact = (field, value) => {
    const updated = { ...contact, [field]: value }
    setContact(updated)
    pagesAPI.updateContent('home_contact', updated).catch(() => {})
  }

  const saveCta = (field, value) => {
    const updated = { ...cta, [field]: value }
    setCta(updated)
    pagesAPI.updateContent('home_cta', updated).catch(() => {})
  }

  const savePrograms = (update) => {
    const updated = { ...programs, ...update }
    setPrograms(updated)
    pagesAPI.updateContent('home_programs', updated).catch(() => {})
  }

  const uploadCardImage = async (cardId, e) => {
    const file = e.target.files[0]
    if (!file) return
    e.target.value = ''
    const fd = new FormData()
    fd.append('image', file)
    try {
      await homepageAPI.uploadImage(cardId, fd)
      setCards(prev => prev.map(c => c.id === cardId ? { ...c, hasImage: true } : c))
      setCardTimestamps(prev => ({ ...prev, [cardId]: Date.now() }))
    } catch (err) {
      alert(err?.response?.data?.message || 'Upload failed. Make sure you are logged in as admin.')
    }
  }

  const uploadOneSlot = async (slotKey, file) => {
    const fd = new FormData()
    fd.append('image', file)
    await pagesAPI.uploadImage(slotKey, fd).catch(() => {})
  }

  const schedule = contact.schedule ?? DEFAULT_CONTACT.schedule

  return (
    <div className="bg-white">
      {/* ── Hero ── */}
      <section className="relative h-screen -mt-[84px] overflow-hidden">
        <EditableBanner
          className="absolute inset-0 w-full h-full"
          title="Banner 1 — Hero"
          slots={bannerSlots}
          onUploadSlot={async (i, file) => {
            await uploadOneSlot(`home_banner_${i}`, file)
            loadBannerSlots('home_banner_', setBannerSlots)
          }}
          onDeleteSlot={async (i) => {
            await pagesAPI.deleteImage(bannerSlots[i].id).catch(() => {})
            loadBannerSlots('home_banner_', setBannerSlots)
          }}
        >
          <BannerSlideshow className="absolute inset-0 w-full h-full" slots={bannerSlots} />
        </EditableBanner>
        <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/5 to-black/20 pointer-events-none" />
        <div className="absolute bottom-14 left-0 right-0 text-center px-4">
          <EditableText
            as="p"
            value={hero.subheadline}
            onChange={v => setHero(h => ({ ...h, subheadline: v }))}
            onSave={v => saveHero('subheadline', v)}
            placeholder="Your tagline"
            className="text-white/60 text-[10px] tracking-[0.4em] uppercase mb-5 font-light"
          />
          <EditableText
            as="h1"
            value={hero.headline}
            onChange={v => setHero(h => ({ ...h, headline: v }))}
            onSave={v => saveHero('headline', v)}
            placeholder="Your club name"
            className="font-display text-white text-5xl md:text-6xl lg:text-7xl font-normal tracking-tight mb-7 leading-none"
          />
          <div className="flex items-center justify-center gap-8">
            {isAuthenticated ? (
              <Link to="/play" className="text-white/90 text-[11px] tracking-[0.25em] uppercase border-b border-white/50 hover:border-white hover:text-white pb-0.5 transition-colors">
                Join Social Play
              </Link>
            ) : (
              <>
                <Link to="/register" className="text-white/90 text-[11px] tracking-[0.25em] uppercase border-b border-white/50 hover:border-white hover:text-white pb-0.5 transition-colors">
                  Join the Club
                </Link>
                <span className="text-white/20">|</span>
                <Link to="/play" className="text-white/90 text-[11px] tracking-[0.25em] uppercase border-b border-white/50 hover:border-white hover:text-white pb-0.5 transition-colors">
                  Social Play
                </Link>
              </>
            )}
          </div>
        </div>
      </section>

      {/* ── Intro ── */}
      <section className="py-14 px-6 lg:px-10">
        <div className="max-w-2xl mx-auto text-center">
          <EditableText
            as="h2"
            value={intro.headline}
            onChange={v => setIntro(h => ({ ...h, headline: v }))}
            onSave={v => saveIntro('headline', v)}
            placeholder="Section headline"
            className="font-display text-5xl md:text-6xl font-bold text-black mb-5 leading-tight"
          />
          <EditableText
            as="p"
            value={intro.body1}
            onChange={v => setIntro(h => ({ ...h, body1: v }))}
            onSave={v => saveIntro('body1', v)}
            multiline
            placeholder="Tell visitors about your club..."
            className="text-gray-700 leading-relaxed mb-3"
          />
          <EditableText
            as="p"
            value={intro.body2}
            onChange={v => setIntro(h => ({ ...h, body2: v }))}
            onSave={v => saveIntro('body2', v)}
            multiline
            placeholder="Add more details here..."
            className="text-gray-700 leading-relaxed mb-8"
          />
          <div className="grid grid-cols-3 gap-8 mb-8 border-t border-gray-100 pt-8">
            {[
              { value: stats.membersDisplay, label: "Members" },
              { value: "6", label: "Courts" },
              { value: stats.socialSessions, label: "Social Sessions" },
            ].map(({ value, label }) => (
              <div key={label}>
                <p className="font-display text-4xl font-bold text-black">{value}</p>
                <p className="text-gray-400 text-xs tracking-widest uppercase mt-1">{label}</p>
              </div>
            ))}
          </div>
          <Link to="/about" className="inline-block border border-black rounded-full px-10 py-3 text-sm text-black hover:bg-black hover:text-white transition-colors duration-200">
            Discover More
          </Link>
        </div>
      </section>

      {/* ── Full-width photo (Banner 2) ── */}
      <EditableBanner
        className="w-full h-screen"
        title="Banner 2 — Mid"
        slots={bannerSlots2}
        onUploadSlot={async (i, file) => {
          await uploadOneSlot(`home_banner2_${i}`, file)
          loadBannerSlots('home_banner2_', setBannerSlots2)
        }}
        onDeleteSlot={async (i) => {
          await pagesAPI.deleteImage(bannerSlots2[i].id).catch(() => {})
          loadBannerSlots('home_banner2_', setBannerSlots2)
        }}
      >
        <BannerSlideshow className="w-full h-full" slots={bannerSlots2} />
      </EditableBanner>

      {/* ── Programs ── */}
      <section className="py-14 px-6 lg:px-10">
        <div className="max-w-6xl mx-auto">
          <EditableText
            as="h2"
            value={programs.headline}
            onSave={v => savePrograms({ headline: v })}
            className="font-display text-3xl md:text-4xl font-bold text-black text-center mb-10 leading-snug"
          />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {cards.map((card) => {
              const title = programs.cardTitles?.[card.id] ?? card.title
              const cardBase = homepageAPI.getImageUrl(card.id)
              const cardSep = cardBase.includes('?') ? '&' : '?'
              const imgSrc = card.hasImage
                ? `${cardBase}${cardTimestamps[card.id] ? `${cardSep}t=${cardTimestamps[card.id]}` : ''}`
                : CARD_FALLBACKS[card.id]
              return (
                <div key={card.id} className="flex flex-col">
                  <div className="relative aspect-[3/4] bg-gray-100 overflow-hidden mb-4 group">
                    <img
                      src={imgSrc}
                      alt={title}
                      onError={e => { e.currentTarget.src = CARD_FALLBACKS[card.id] }}
                      className="w-full h-full object-cover hover:scale-105 transition-transform duration-500"
                    />
                    {isEditing && (
                      <>
                        <button
                          onClick={() => cardInputRefs.current[card.id]?.click()}
                          className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Camera size={22} className="text-white" />
                        </button>
                        <input
                          ref={el => { cardInputRefs.current[card.id] = el }}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={e => uploadCardImage(card.id, e)}
                        />
                      </>
                    )}
                  </div>
                  {isEditing ? (
                    <EditableText
                      as="span"
                      value={title}
                      onSave={v => savePrograms({ cardTitles: { ...programs.cardTitles, [card.id]: v } })}
                      className="text-sm font-medium text-black text-center leading-snug"
                    />
                  ) : (
                    <Link to={`/training#${card.id}`} className="text-sm font-medium text-black hover:text-gray-500 transition-colors text-center leading-snug">
                      {title}
                    </Link>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* ── Full-width photo (Banner 3) ── */}
      <EditableBanner
        className="w-full h-screen"
        title="Banner 3 — Bottom"
        slots={bannerSlots3}
        onUploadSlot={async (i, file) => {
          await uploadOneSlot(`home_banner3_${i}`, file)
          loadBannerSlots('home_banner3_', setBannerSlots3)
        }}
        onDeleteSlot={async (i) => {
          await pagesAPI.deleteImage(bannerSlots3[i].id).catch(() => {})
          loadBannerSlots('home_banner3_', setBannerSlots3)
        }}
      >
        <BannerSlideshow className="w-full h-full" slots={bannerSlots3} />
      </EditableBanner>

      {/* ── Schedule ── */}
      <section className="py-12 px-6 lg:px-10">
        <div className="max-w-3xl mx-auto text-center">
          <p className="text-xs tracking-[0.3em] uppercase text-gray-400 mb-3">Opening Hours</p>
          <h2 className="font-display text-4xl font-bold text-black mb-8">Weekly Schedule</h2>
          <div className="divide-y divide-gray-100 border-t border-gray-100">
            {schedule.map(({ day, time, label = 'Open Practice' }, idx) => (
              <div key={idx} className="flex items-center justify-between py-5 gap-4">
                <EditableText
                  as="span"
                  value={day}
                  onSave={v => {
                    const updated = schedule.map((r, i) => i === idx ? { ...r, day: v } : r)
                    saveContact('schedule', updated)
                  }}
                  className="font-display text-2xl font-bold text-black w-16 text-left"
                />
                <EditableText
                  as="span"
                  value={label}
                  onSave={v => {
                    const updated = schedule.map((r, i) => i === idx ? { ...r, label: v } : r)
                    saveContact('schedule', updated)
                  }}
                  className="text-gray-700 text-sm tracking-wider flex-1 text-center"
                />
                <EditableText
                  as="span"
                  value={time}
                  onSave={v => {
                    const updated = schedule.map((r, i) => i === idx ? { ...r, time: v } : r)
                    saveContact('schedule', updated)
                  }}
                  className="text-gray-700 text-sm w-32 text-right"
                />
                {isEditing && (
                  <button
                    onClick={() => {
                      const updated = schedule.filter((_, i) => i !== idx)
                      saveContact('schedule', updated)
                    }}
                    className="text-gray-300 hover:text-red-500 transition-colors flex-shrink-0"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>
          {isEditing && (
            <button
              onClick={() => {
                const updated = [...schedule, { day: 'Day', time: '00:00 – 00:00 PM', label: 'Open Practice' }]
                saveContact('schedule', updated)
              }}
              className="mt-4 flex items-center gap-1.5 text-xs text-gray-400 hover:text-black transition-colors mx-auto"
            >
              <Plus size={14} /> Add row
            </button>
          )}
        </div>
      </section>

      {/* ── Location ── */}
      <section className="border-t border-gray-100 py-12 px-6 lg:px-10 bg-gray-50">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-8">
            <p className="text-xs tracking-[0.3em] uppercase text-gray-400 mb-3">Location</p>
            <h2 className="font-display text-4xl font-bold text-black">Find Us</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-8">
            <div className="text-center">
              <p className="text-xs tracking-[0.2em] uppercase text-gray-600 font-semibold mb-3">Getting Here</p>
              <EditableText
                as="p"
                value={contact.gettingHere || DEFAULT_CONTACT.gettingHere}
                onChange={v => setContact(c => ({ ...c, gettingHere: v }))}
                onSave={v => saveContact('gettingHere', v)}
                multiline
                className="text-gray-800 text-sm leading-relaxed whitespace-pre-line"
              />
            </div>
            <div className="text-center">
              <p className="text-xs tracking-[0.2em] uppercase text-gray-600 font-semibold mb-3">Address</p>
              <EditableText
                as="p"
                value={contact.address}
                onChange={v => setContact(c => ({ ...c, address: v }))}
                onSave={v => saveContact('address', v)}
                multiline
                className="text-gray-800 text-sm leading-relaxed whitespace-pre-line"
              />
            </div>
            <div className="text-center">
              <p className="text-xs tracking-[0.2em] uppercase text-gray-600 font-semibold mb-3">Contact</p>
              <EditableText
                as="p"
                value={contact.phone}
                onChange={v => setContact(c => ({ ...c, phone: v }))}
                onSave={v => saveContact('phone', v)}
                className="text-gray-800 text-sm"
              />
              <EditableText
                as="p"
                value={contact.email}
                onChange={v => setContact(c => ({ ...c, email: v }))}
                onSave={v => saveContact('email', v)}
                className="text-gray-800 text-sm mt-1"
              />
              {contact.wechat && (
                <EditableText
                  as="p"
                  value={`WeChat: ${contact.wechat}`}
                  onChange={v => setContact(c => ({ ...c, wechat: v.replace('WeChat: ', '') }))}
                  onSave={v => saveContact('wechat', v.replace('WeChat: ', ''))}
                  className="text-gray-800 text-sm mt-1"
                />
              )}
            </div>
          </div>
          <div className="overflow-hidden h-[420px]">
            <iframe
              title="Club location"
              src={`https://maps.google.com/maps?q=${encodeURIComponent(club?.settings?.address || contact.address || 'Epping NSW 2121 Australia')}&output=embed`}
              width="100%" height="100%"
              style={{ border: 0 }}
              allowFullScreen loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="py-12 px-6 lg:px-10 text-center border-t border-gray-100">
        <p className="text-xs tracking-[0.3em] uppercase text-gray-500 mb-6">Join Us</p>
        <EditableText
          as="h2"
          value={cta.headline}
          onSave={v => saveCta('headline', v)}
          placeholder="Call to action headline"
          className="font-display text-5xl md:text-6xl font-light tracking-wide text-black mb-6"
        />
        <EditableText
          as="p"
          value={cta.body}
          onSave={v => saveCta('body', v)}
          multiline
          placeholder="Invite visitors to join your club..."
          className="text-gray-700 mb-10 font-light max-w-md mx-auto leading-relaxed"
        />
        {isAuthenticated ? (
          <Link to="/play" className="inline-block border border-black rounded-full px-10 py-3 text-sm text-black hover:bg-black hover:text-white transition-colors duration-200">
            Join Social Play
          </Link>
        ) : (
          <div className="flex items-center justify-center gap-6">
            <Link to="/register" className="inline-block border border-black rounded-full px-10 py-3 text-sm text-black hover:bg-black hover:text-white transition-colors duration-200">
              Join the Club
            </Link>
            <Link to="/login" className="inline-block border border-black rounded-full px-10 py-3 text-sm text-black hover:bg-black hover:text-white transition-colors duration-200">
              Sign In
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
