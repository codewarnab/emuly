import { notFound } from "next/navigation";
import { DeleteRequestView } from "@/components/phone/delete-request-view";
import { DeletePhoneArt } from "@/components/phone/delete-phone-art";
import s from "@/components/link/link.module.css";

export const metadata = { title: "Delete phone (preview) — Emuly" };

/** Dev-only preview of the delete approval page, with dummy data. Not served in production. */
export default function DeletePreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className={s.page} id="main-content" tabIndex={-1}>
      <section className={s.text} aria-labelledby="delete-title">
        <DeleteRequestView token="dummy-token" name="phone-crystal-bison" state="running" apps={7} />
      </section>
      <div className={s.device}><DeletePhoneArt name="phone-crystal-bison" /></div>
    </main>
  );
}
