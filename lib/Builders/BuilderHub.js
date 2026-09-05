import { AIRich } from './AIRich.js'
import { Button } from './Button.js'
import { ButtonV2 } from './ButtonV2.js'
import { ButtonV3 } from './ButtonV3.js'
import { Carousel } from './Carousel.js'
import { Poll } from './Poll.js'
import { A2UI } from './A2UI.js'

class BuilderHub {
  constructor(client) {
    if (!client) {
      throw new TypeError(
        'BuilderHub(client) requires an active Baileys socket/client'
      )
    }

    this.client = client
  }

  airich() {
    return new AIRich(this.client)
  }

  button() {
    return new Button(this.client)
  }

  buttonV2() {
    return new ButtonV2(this.client)
  }

  buttonV3() {
    return new ButtonV3(this.client)
  }

  carousel() {
    return new Carousel(this.client)
  }

  poll() {
    return new Poll(this.client)
  }

  a2ui() {
    return new A2UI()
  }

  AIRich() {
    return this.airich()
  }

  Button() {
    return this.button()
  }

  ButtonV2() {
    return this.buttonV2()
  }

  ButtonV3() {
    return this.buttonV3()
  }

  Carousel() {
    return this.carousel()
  }

  Poll() {
    return this.poll()
  }

  A2UI() {
    return this.a2ui()
  }
}

export { BuilderHub }
