import s from "./console.module.css";

export function AddCard() {
  return (
    <div className={s.addcard}>
      <div className={s.plus}>+</div>
      <b>Add a second phone</b>
      <span>One of two phone slots is available.</span>
    </div>
  );
}
