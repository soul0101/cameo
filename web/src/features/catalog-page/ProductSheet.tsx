import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Check } from '@phosphor-icons/react';
import { audienceChain, CATEGORIES, hueOf } from '@/data/catalog';
import type { CatalogProduct, CategoryId } from '@/data/catalog';
import { AudienceIcon } from '@/features/audiences/AudienceBar';
import { cx } from '@/lib/cx';
import { useProject } from '@/store/project';
import type { Audience, AudienceId } from '@/store/project';
import { Button, Input, Segmented, Sheet, toast } from '@/ui';
import { ImagesField } from './ImagesField';

const label = 'text-13 font-medium text-text-2';

type FieldKey = 'name' | 'brand' | 'category' | 'url' | 'avail';

/**
 * Add / Edit product: Name · Brand (autocomplete from the catalog's
 * brands, can be new) · Category · Link · Images
 * · Available in: "All audiences / Only some", and in "Only some" checkbox chips per audience
 * (prefilled with the filtered audience). Errors show after the first save attempt; one toast.
 */
export function ProductSheet({
  open,
  audience,
  product,
  brands,
  onClose,
}: {
  open: boolean;
  /** The catalog's audience filter: a new product starts as "Only some" with it ticked. null = All. */
  audience: Audience | null;
  /** null = add a new product. */
  product: CatalogProduct | null;
  brands: string[];
  onClose: () => void;
}) {
  const products = useProject((s) => s.products);
  const audiences = useProject((s) => s.audiences);
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [category, setCategory] = useState<CategoryId | null>(null);
  const [url, setUrl] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [scope, setScope] = useState<'all' | 'some'>('all');
  const [picked, setPicked] = useState<AudienceId[]>([]);
  /** Errors show once the user tried to save, not while they are still typing. */
  const [tried, setTried] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const ids = { name: useId(), brand: useId(), cat: useId(), url: useId(), list: useId(), avail: useId() };

  useEffect(() => {
    if (!open) return;
    setName(product?.name ?? '');
    setBrand(product?.brand ?? '');
    setCategory(product?.category ?? null);
    setUrl(product?.url ?? '');
    setImages(product?.images ?? []);
    setSuggestOpen(false);
    setTried(false);
    if (product) {
      setScope(product.availableIn === 'all' ? 'all' : 'some');
      setPicked(product.availableIn === 'all' ? (audience ? [audience.id] : []) : product.availableIn);
    } else {
      setScope(audience ? 'some' : 'all');
      setPicked(audience ? [audience.id] : []);
    }
  }, [open, product, audience]);

  const matches = useMemo(() => {
    const q = brand.trim().toLowerCase();
    return brands.filter((b) => b.toLowerCase().includes(q) && b.toLowerCase() !== q).slice(0, 6);
  }, [brands, brand]);

  const pickBrand = (b: string) => {
    setBrand(b);
    setSuggestOpen(false);
    // An existing brand brings its category along when none is chosen yet.
    if (!category) {
      const cat = products.find((p) => p.brand.trim().toLowerCase() === b.toLowerCase())?.category;
      if (cat) setCategory(cat);
    }
  };

  const urlOk = !url.trim() || /^https?:\/\/\S+\.\S+/.test(url.trim());
  const live = picked.filter((id) => audiences.some((a) => a.id === id));
  const errors: Record<FieldKey, string> = {
    name: name.trim() ? '' : 'Give the product a name',
    brand: brand.trim() ? '' : 'Add the brand',
    category: category ? '' : 'Pick a category',
    url: urlOk ? '' : 'Use a full link that starts with https://',
    avail: scope === 'some' && live.length === 0 ? 'Pick at least one audience' : '',
  };
  const valid = !Object.values(errors).some(Boolean);
  const show = (k: FieldKey) => (tried ? errors[k] : '');
  /** Audiences that see a picked audience's products without being picked themselves (`basedOn`). */
  const inherited = (id: AudienceId) => !live.includes(id) && audienceChain(id, audiences).some((x) => x !== id && live.includes(x));
  const togglePick = (id: AudienceId) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const save = () => {
    if (!valid || !category) {
      setTried(true);
      const first = (['name', 'brand', 'category', 'url', 'avail'] as const).find((k) => errors[k]);
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(`[data-field="${first}"]`)?.focus());
      return;
    }
    const s = useProject.getState();
    const availableIn = scope === 'all' ? ('all' as const) : audiences.filter((a) => live.includes(a.id)).map((a) => a.id);
    const fields = { name: name.trim(), brand: brand.trim(), category, url: url.trim(), images, availableIn };
    const where = availableIn === 'all' ? 'every audience' : availableIn.map((id) => audiences.find((a) => a.id === id)?.name ?? id).join(', ');
    if (product) {
      s.updateProduct(product.id, fields);
      toast({ title: `Saved ${fields.name}`, tone: 'pass' });
    } else {
      s.addProduct(fields);
      toast({ title: `Added ${fields.name}`, description: `Available in ${where}`, tone: 'pass' });
    }
    onClose();
  };

  const onBrandKey = (e: KeyboardEvent) => {
    if (!suggestOpen || !matches.length) return;
    if (e.key === 'ArrowDown') (e.preventDefault(), setHi((h) => (h + 1) % matches.length));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => (h - 1 + matches.length) % matches.length));
    else if (e.key === 'Enter') (e.preventDefault(), pickBrand(matches[hi]));
    else if (e.key === 'Escape') (e.stopPropagation(), setSuggestOpen(false));
  };

  const newBrand = brand.trim() && !brands.some((b) => b.toLowerCase() === brand.trim().toLowerCase());

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={product ? `Edit ${product.name}` : 'Add product'}
      width={460}
      translucent
      footer={
        <>
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            {product ? 'Save changes' : 'Add product'}
          </Button>
        </>
      }
    >
      <form
        ref={formRef}
        noValidate
        className="flex flex-col gap-5 px-5 pt-1 pb-6"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.name} className={label}>
            Name
          </label>
          <Input
            id={ids.name}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Kaya Toast Bites"
            autoComplete="off"
            data-autofocus
            data-field="name"
            aria-invalid={!!show('name') || undefined}
            aria-describedby={show('name') ? `${ids.name}-err` : undefined}
            className="h-10"
          />
          {show('name') && <FieldError id={`${ids.name}-err`}>{show('name')}</FieldError>}
        </div>

        <div className="relative flex flex-col gap-1.5">
          <label htmlFor={ids.brand} className={label}>
            Brand
          </label>
          <Input
            id={ids.brand}
            value={brand}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestOpen && matches.length > 0}
            aria-controls={ids.list}
            aria-activedescendant={suggestOpen && matches.length ? `${ids.list}-${hi}` : undefined}
            onChange={(e) => {
              setBrand(e.target.value);
              setSuggestOpen(true);
              setHi(0);
            }}
            onFocus={() => setSuggestOpen(true)}
            onBlur={() => window.setTimeout(() => setSuggestOpen(false), 120)}
            onKeyDown={onBrandKey}
            placeholder="Start typing, or pick an existing brand"
            autoComplete="off"
            data-field="brand"
            aria-invalid={!!show('brand') || undefined}
            className="h-10"
          />
          {suggestOpen && matches.length > 0 && (
            <ul id={ids.list} role="listbox" aria-label="Brands" className="surface absolute top-[calc(100%+4px)] right-0 left-0 z-10 flex max-h-56 flex-col overflow-y-auto rounded-[12px]! p-1">
              {matches.map((b, i) => (
                <li
                  key={b}
                  id={`${ids.list}-${i}`}
                  role="option"
                  aria-selected={i === hi}
                  onMouseDown={(e) => (e.preventDefault(), pickBrand(b))}
                  onMouseEnter={() => setHi(i)}
                  className={cx('flex h-9 cursor-pointer items-center gap-2.5 rounded-[8px] px-2 text-14 text-text', i === hi && 'bg-surface-3')}
                >
                  <span
                    aria-hidden
                    className="inline-flex size-5 items-center justify-center rounded-[5px] text-11 font-semibold"
                    style={{ background: `hsl(${hueOf(b)} 36% 26%)`, color: `hsl(${hueOf(b)} 70% 86%)` }}
                  >
                    {b.charAt(0).toUpperCase()}
                  </span>
                  {b}
                </li>
              ))}
            </ul>
          )}
          {show('brand') && !suggestOpen && <FieldError>{show('brand')}</FieldError>}
          {newBrand && !suggestOpen && <span className="text-12 text-text-3">New brand</span>}
        </div>

        <fieldset className="flex flex-col">
          <legend id={ids.cat} className={cx(label, 'pb-1.5')}>
            Category
          </legend>
          <div role="radiogroup" aria-labelledby={ids.cat} className="grid grid-cols-4 gap-1.5 max-sm:grid-cols-2">
            {CATEGORIES.map((c, i) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={category === c}
                data-field={i === 0 ? 'category' : undefined}
                onClick={() => setCategory(c)}
                className={cx(
                  'h-9 rounded-[10px] border px-2 text-13 font-medium transition-[background-color,color,border-color] duration-200 ease-cameo max-md:h-11',
                  category === c ? 'border-transparent bg-text text-surface' : 'border-border bg-surface-2/60 text-text-2 hover:bg-surface-3 hover:text-text',
                )}
              >
                {c}
              </button>
            ))}
          </div>
          {show('category') && <FieldError className="pt-1.5">{show('category')}</FieldError>}
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.url} className={label}>
            Link
          </label>
          <Input
            id={ids.url}
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => !urlOk && setTried(true)}
            placeholder="https://brand.com/product"
            autoComplete="off"
            data-field="url"
            aria-invalid={!!show('url') || undefined}
            className="h-10"
          />
          {show('url') && <FieldError>{show('url')}</FieldError>}
        </div>

        <fieldset className="flex flex-col gap-2.5">
          <legend id={ids.avail} className={cx(label, 'pb-1.5')}>
            Available in
          </legend>
          <Segmented
            label="Available in"
            value={scope}
            onChange={(v) => {
              setScope(v);
              if (v === 'some' && !picked.length && audience) setPicked([audience.id]);
            }}
            options={[
              { value: 'all', label: 'All audiences' },
              { value: 'some', label: 'Only some' },
            ]}
            className="self-start"
          />
          {scope === 'some' && (
            <div role="group" aria-labelledby={ids.avail} className="flex flex-wrap gap-1.5">
              {audiences.map((a, i) => {
                const on = live.includes(a.id);
                const via = inherited(a.id);
                const basis = a.basedOn ? audiences.find((x) => x.id === a.basedOn) : undefined;
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-description={via && basis ? `Sees ${basis.name}’s products` : undefined}
                    data-field={i === 0 ? 'avail' : undefined}
                    onClick={() => togglePick(a.id)}
                    className={cx(
                      'inline-flex h-8 items-center gap-2 rounded-[10px] border pr-3 pl-2 text-13 font-medium transition-[background-color,color,border-color] duration-200 ease-cameo max-md:h-11',
                      on ? 'border-accent/40 bg-accent-soft text-text' : 'border-border bg-surface-2/60 text-text-2 hover:bg-surface-3 hover:text-text',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cx(
                        'inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-200 ease-cameo',
                        on ? 'border-accent bg-accent text-accent-ink' : via ? 'border-dashed border-text-3 text-text-3' : 'border-border-strong',
                      )}
                    >
                      {(on || via) && <Check size={11} weight="bold" />}
                    </span>
                    <AudienceIcon kind={a.kind} size={14} className={on ? 'text-accent' : 'text-text-3'} />
                    {a.name}
                    {via && basis && <span className="-ml-0.5 font-normal text-text-3">via {basis.name}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {show('avail') && <FieldError>{show('avail')}</FieldError>}
        </fieldset>

        <ImagesField images={images} onChange={setImages} active={open} />
      </form>
    </Sheet>
  );
}

function FieldError({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <span id={id} className={cx('text-12 text-reject', className)}>
      {children}
    </span>
  );
}
