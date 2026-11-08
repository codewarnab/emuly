import s from "@/components/console.module.css";

export function Stage() {
  return (
    <div className={s.stage}>
      <span className={s.lab}>Example screen</span>
      <div className={s.phone}>
        <div className={s.notch} />
        <div className={s.phoneScr}>
          <div className={s.sb}>
            <span>9:41</span>
            <span>5G ▮▮▮</span>
          </div>
          <div className={s.clk}>
            <div className={s.clkT}>9:41</div>
          </div>
          <div className={s.grid4}>
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
        </div>
      </div>
      <div className={s.controls}>
        <button className={s.ctl} disabled title="Screen controls are not available yet" aria-describedby="screen-controls-note" aria-label="Home">⌂</button>
        <button className={s.ctl} disabled title="Screen controls are not available yet" aria-describedby="screen-controls-note" aria-label="Back">←</button>
        <button className={s.ctl} disabled title="Screen controls are not available yet" aria-describedby="screen-controls-note" aria-label="Rotate">⟳</button>
        <button className={s.ctl} disabled title="Screen controls are not available yet" aria-describedby="screen-controls-note" aria-label="Save screenshot">⤓</button>
      </div>
      <div className={s.takeover} id="screen-controls-note">
        Screen controls are not available yet.
      </div>
    </div>
  );
}
