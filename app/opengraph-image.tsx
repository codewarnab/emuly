import { ImageResponse } from "next/og";

export const alt = "Emuly — run an Android emulator in the cloud, free";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const ink = "#e8edf6";
const dim = "#8fa1bb";
const accent = "#3159bf";

export default function Image() {
  return new ImageResponse(
    <div style={{
      width: "100%", height: "100%", display: "flex", position: "relative",
      background: "#121c2e", color: ink, fontFamily: "sans-serif", overflow: "hidden",
    }}>
      <div style={{
        position: "absolute", right: -160, top: -120, width: 760, height: 760, borderRadius: 760,
        background: "radial-gradient(circle, #3159bf55 0%, #3159bf00 65%)", display: "flex",
      }} />
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "72px 0 72px 80px", width: 760 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <svg width="52" height="52" viewBox="0 0 64 64">
            <rect width="64" height="64" rx="14" fill={accent} />
            <rect x="20" y="9" width="24" height="46" rx="7" fill="none" stroke="#fff" strokeWidth="5" />
            <rect x="27" y="44" width="10" height="4" rx="2" fill="#fff" />
          </svg>
          <span style={{ fontSize: 34, fontWeight: 700, letterSpacing: -0.5 }}>Emuly</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 68, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2 }}>
            <span>Android emulator</span>
            <span>in the cloud.</span>
            <span style={{ color: "#a9bfff" }}>Free.</span>
          </div>
          <span style={{ fontSize: 26, color: dim, lineHeight: 1.4 }}>
            Runs in your own GitHub Codespace.
          </span>
        </div>
        <span style={{ fontSize: 22, color: dim, letterSpacing: 0.5 }}>emuly.vercel.app</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, paddingRight: 40 }}>
        <div style={{
          display: "flex", width: 260, height: 520, borderRadius: 44, padding: 12,
          background: "#0b1424", border: "2px solid #4a5f7e",
          boxShadow: "0 40px 80px #040a1499",
        }}>
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center", flex: 1, borderRadius: 34,
            background: "linear-gradient(160deg, #4a73d6 0%, #3159bf 55%, #24448f 100%)", position: "relative",
          }}>
            <div style={{ display: "flex", width: 14, height: 14, borderRadius: 14, background: "#0b1424", marginTop: 14 }} />
            <span style={{ fontSize: 64, fontWeight: 300, marginTop: 70, color: "#fff", letterSpacing: -1 }}>9:41</span>
            <span style={{ fontSize: 18, color: "#e0e9ff", marginTop: 4 }}>Ready</span>
            <div style={{ display: "flex", gap: 18, position: "absolute", bottom: 44 }}>
              {[0, 1, 2, 3].map(i => <div key={i} style={{ display: "flex", width: 34, height: 34, borderRadius: 11, background: "#ffffff30" }} />)}
            </div>
          </div>
        </div>
      </div>
    </div>,
    size,
  );
}
