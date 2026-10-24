"use client";
import type {ReactNode} from 'react';

export default function SignOutButton({className,children}:{className?:string;children?:ReactNode}) {
  return <form action="/auth/signout" method="post"><button className={className} type="submit">{children || 'Sign out'}</button></form>;
}
