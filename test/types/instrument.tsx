// Compile-only: @instrument's skip paths are checked against the method's parameter types.
import { instrument } from "@toyz/yerd";

interface Signup {
  email: string;
  password: string;
  profile: { name: string; billing?: { card: string; cvc: string } };
  tags: Array<{ label: string; secret: string }>;
}

export class Accounts {
  // Names are free-form for the compiler (it can't see parameter names) but
  // the path after them is checked; positions are checked all the way down.
  @instrument({ skip: ["input.password", "input.profile.billing.cvc", "1.headers.authorization", "input.tags.0.secret"] })
  create(input: Signup, request: { headers: { authorization: string; host: string } }) {
    return input.email + request.headers.host;
  }

  @instrument({ skip: ["password", "0", "1.0.token"] })
  login(password: string, extra: string, tokens: Array<{ token: string }>) {
    return password + extra + tokens.length;
  }

  // @ts-expect-error "input.pasword": no parameter has that field
  @instrument({ skip: ["input.pasword"] })
  typo(input: Signup) {
    return input;
  }

  // @ts-expect-error "1.headers.cookie": request.headers has no cookie
  @instrument({ skip: ["1.headers.cookie"] })
  wrongNested(input: Signup, request: { headers: { authorization: string } }) {
    return [input, request];
  }

  // @ts-expect-error "3": there's no fourth argument
  @instrument({ skip: ["3"] })
  outOfRange(a: string, b: string) {
    return a + b;
  }

  // @ts-expect-error "input.profile.billing.pin": billing has card and cvc only
  @instrument({ skip: ["input.profile.billing.pin"] })
  deepTypo(input: Signup) {
    return input;
  }
}
