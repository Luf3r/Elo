# Descoberta incremental para a T01

- Confirmar a rota e os limites do contrato público; bloquear transporte de produção enquanto a prova de escopo não existir.
- Ler uma página por chamada, de uma única caixa autorizada. Persistir cursor opaco ligado ao ator, conta, política e caixa. Limitar o ciclo e detectar páginas repetidas.
- Persistir a observação por conta, caixa, conversa, atividade e status. Reutilizar a reserva existente ao preparar a observação em preview e revalidar a listagem antes das rotas de conteúdo.
- Registrar conclusão somente com análise/plano persistidos. Reexecutar a suíte sintética e o fluxo OAuth/MCP com SQLite e evicção. Reportar o estado do teste no cliente Zapia separadamente.
