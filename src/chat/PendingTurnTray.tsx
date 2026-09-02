import { Check, ChevronDown, ChevronRight, ListPlus, LoaderCircle, Pencil, Route, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { PendingTurn } from "./types";

type Props<TAttachment> = {
  items: PendingTurn<TAttachment>[];
  running: boolean;
  onEdit: (inputId: string, text: string) => Promise<void>;
  onRemove: (inputId: string) => Promise<void>;
  onPromote: (inputId: string) => Promise<void>;
};

export function PendingTurnTray<TAttachment>({ items, running, onEdit, onRemove, onPromote }: Props<TAttachment>) {
  const [open, setOpen] = useState(true);
  const [editingId, setEditingId] = useState("");
  const [editingText, setEditingText] = useState("");
  const [busyId, setBusyId] = useState("");
  useEffect(() => { if (items.length === 1) setOpen(true); }, [items.length]);
  if (!items.length) return null;

  const action = async (id: string, work: () => Promise<void>) => {
    setBusyId(id);
    try { await work(); }
    catch { /* The parent reports API failures without losing the current editor state. */ }
    finally { setBusyId(""); }
  };

  return <section className={`pending-turn-tray ${open ? "open" : ""}`} aria-label="待发送消息">
    <button type="button" className="pending-turn-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span><ListPlus size={13} /><strong>待发送 {items.length}</strong><small>{running ? "当前轮次完成后自动继续" : "等待继续运行"}</small></span>
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
    </button>
    {open && <div className="pending-turn-list">
      {items.map((item, index) => {
        const steering = item.status === "steering" || item.mode === "steer";
        const busy = busyId === item.id;
        const editing = editingId === item.id;
        return <article className={`pending-turn-item ${steering ? "steering" : ""}`} key={item.id}>
          <span className="pending-turn-index">{steering ? <Route size={13} /> : index + 1}</span>
          {editing ? <div className="pending-turn-editor"><textarea value={editingText} autoFocus onChange={(event) => setEditingText(event.target.value)} /><div><button type="button" title="取消编辑" onClick={() => setEditingId("")}><X size={13} /></button><button type="button" title="保存修改" disabled={!editingText.trim() || busy} onClick={() => void action(item.id, async () => { await onEdit(item.id, editingText); setEditingId(""); })}><Save size={13} /></button></div></div> : <div className="pending-turn-copy"><strong>{steering ? "正在应用引导" : `排队 ${index + 1}`}</strong><p>{item.text}</p>{Boolean(item.attachments?.length) && <small>{item.attachments?.length} 个附件</small>}</div>}
          {!editing && <div className="pending-turn-actions">
            {busy || steering ? <span className="pending-turn-locked">{busy ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}</span> : <>
              <button type="button" title="编辑排队消息" onClick={() => { setEditingId(item.id); setEditingText(item.text); }}><Pencil size={13} /></button>
              <button type="button" title="删除排队消息" onClick={() => void action(item.id, () => onRemove(item.id))}><Trash2 size={13} /></button>
              <button type="button" className="promote" title={running ? "中断当前轮次并立即引导" : "立即运行这条消息"} onClick={() => void action(item.id, () => onPromote(item.id))}><Route size={13} /><span>{running ? "立即引导" : "立即运行"}</span></button>
            </>}
          </div>}
        </article>;
      })}
    </div>}
  </section>;
}
