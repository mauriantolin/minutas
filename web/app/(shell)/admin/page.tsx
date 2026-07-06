"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, MoreHorizontal, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useAuth } from "@/components/auth-provider";
import {
  createUser,
  deleteUser,
  listUsers,
  resetPassword,
  setRole,
  type AdminUser,
} from "@/lib/admin";

function statusLabel(status: string): { label: string; variant: "secondary" | "outline" } {
  if (status === "CONFIRMED") return { label: "Activo", variant: "secondary" };
  if (status === "FORCE_CHANGE_PASSWORD") return { label: "Pendiente", variant: "outline" };
  return { label: status, variant: "outline" };
}

function Header() {
  return (
    <header className="flex h-14 items-center gap-3 border-b px-6">
      <SidebarTrigger />
      <h1 className="text-xl font-semibold tracking-tight">Administración</h1>
    </header>
  );
}

export default function AdminPage() {
  const { token, email, isAdmin } = useAuth();

  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newTenant, setNewTenant] = useState("");
  const [newAdmin, setNewAdmin] = useState(false);
  const [creating, setCreating] = useState(false);

  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPwd, setResetPwd] = useState("");
  const [resetting, setResetting] = useState(false);

  const [deleteFor, setDeleteFor] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const { users } = await listUsers(token);
      setUsers(users);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudieron cargar los usuarios");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (isAdmin) void refetch();
  }, [isAdmin, refetch]);

  if (!isAdmin) {
    return (
      <>
        <Header />
        <div className="mx-auto flex w-full max-w-2xl px-6 py-5">
          <Card className="w-full">
            <CardHeader>
              <CardTitle className="text-sm font-medium">No tenés acceso</CardTitle>
              <CardDescription>
                Esta sección es solo para administradores.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </>
    );
  }

  const submitCreate = async () => {
    if (!token || !newEmail.trim() || !newPassword) return;
    setCreating(true);
    try {
      await createUser(token, {
        email: newEmail.trim(),
        password: newPassword,
        tenantId: newTenant.trim() || undefined,
        admin: newAdmin,
      });
      toast.success(`Usuario ${newEmail.trim()} creado`);
      setCreateOpen(false);
      setNewEmail("");
      setNewPassword("");
      setNewTenant("");
      setNewAdmin(false);
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo crear el usuario");
    } finally {
      setCreating(false);
    }
  };

  const submitReset = async () => {
    if (!token || !resetFor || !resetPwd) return;
    setResetting(true);
    try {
      await resetPassword(token, resetFor, resetPwd);
      toast.success("Contraseña restablecida");
      setResetFor(null);
      setResetPwd("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo restablecer la contraseña");
    } finally {
      setResetting(false);
    }
  };

  const toggleRole = async (u: AdminUser) => {
    if (!token) return;
    try {
      await setRole(token, u.email, !u.admin);
      toast.success(u.admin ? "Permisos de admin retirados" : "Ahora es administrador");
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo cambiar el rol");
    }
  };

  const confirmDelete = async () => {
    if (!token || !deleteFor) return;
    try {
      await deleteUser(token, deleteFor);
      toast.success(`Usuario ${deleteFor} eliminado`);
      setDeleteFor(null);
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo eliminar el usuario");
    }
  };

  return (
    <>
      <Header />

      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Gestioná los usuarios que pueden acceder a la plataforma.
          </p>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus />
            Nuevo usuario
          </Button>
        </div>

        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Admin</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && users === null &&
                  Array.from({ length: 3 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={5}>
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    </TableRow>
                  ))}

                {!loading && users?.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                      Todavía no hay usuarios.
                    </TableCell>
                  </TableRow>
                )}

                {users?.map((u) => {
                  const status = statusLabel(u.status);
                  const isSelf = u.email === email;
                  return (
                    <TableRow key={u.email}>
                      <TableCell className="font-medium">{u.email}</TableCell>
                      <TableCell>
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {u.tenantId ?? "—"}
                      </TableCell>
                      <TableCell>
                        {u.admin && (
                          <Badge variant="secondary">
                            <ShieldCheck />
                            Admin
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-8">
                              <MoreHorizontal />
                              <span className="sr-only">Acciones</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuItem onSelect={() => setResetFor(u.email)}>
                              Restablecer contraseña
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => void toggleRole(u)}>
                              {u.admin ? "Quitar admin" : "Hacer admin"}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={isSelf}
                              onSelect={() => setDeleteFor(u.email)}
                            >
                              Eliminar
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Nuevo usuario</DialogTitle>
            <DialogDescription>
              Se crea en Cognito y podrá iniciar sesión con estas credenciales.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-email">Email</Label>
              <Input
                id="new-email"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-password">Contraseña</Label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-tenant">Tenant</Label>
              <Input
                id="new-tenant"
                placeholder="vacío = individual"
                value={newTenant}
                onChange={(e) => setNewTenant(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="new-admin">Administrador</Label>
              <Switch id="new-admin" checked={newAdmin} onCheckedChange={setNewAdmin} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={submitCreate}
              disabled={creating || !newEmail.trim() || !newPassword}
            >
              {creating ? <Spinner /> : <Check />}
              Crear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={resetFor !== null}
        onOpenChange={(open) => {
          if (!open) {
            setResetFor(null);
            setResetPwd("");
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Restablecer contraseña</DialogTitle>
            <DialogDescription className="truncate">{resetFor}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reset-password">Nueva contraseña</Label>
            <Input
              id="reset-password"
              type="password"
              value={resetPwd}
              onChange={(e) => setResetPwd(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitReset()}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setResetFor(null);
                setResetPwd("");
              }}
            >
              Cancelar
            </Button>
            <Button onClick={submitReset} disabled={resetting || !resetPwd}>
              {resetting ? <Spinner /> : null}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteFor !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteFor(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar a {deleteFor}?</AlertDialogTitle>
            <AlertDialogDescription>
              El usuario perderá el acceso de inmediato. Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
