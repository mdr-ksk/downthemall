"use strict";
// License: MIT

import { EventEmitter } from "../../lib/events";

const $ = document.querySelector.bind(document);

export class Buttons extends EventEmitter {
  private readonly parent: HTMLElement;

  constructor(selector: string) {
    super();
    this.parent = $(selector);
    this.parent.addEventListener("click", this.clicked.bind(this));
  }

  clicked(evt: MouseEvent) {
    let target = <HTMLElement | null> evt.target;
    while (target && target !== this.parent) {
      if (target.classList.contains("button")) {
        const {id} = target;
        if (id) {
          this.emit(id);
          return;
        }
      }
      target = target.parentElement;
    }
  }
}